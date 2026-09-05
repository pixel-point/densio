import { retireExpiredTransfers } from "./expired-transfers.ts";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { Effect } from "effect";
import type { Database } from "../../database/database.ts";
import { organizations } from "../../database/organization-schema.ts";
import {
  storageConnections,
  storageTransfers,
  videos,
} from "../../database/video-storage-schema.ts";
import { writerIsAlive, writerProcessIdentity } from "../../services/writer-process.ts";
import { transitionVideo } from "../../videos/video-lifecycle.ts";
import { storageFailure, storagePromise, VideoStorageError } from "../storage-errors.ts";
import { changeStoredVisibility, deleteStoredVideo } from "./video-visibility.ts";
import { deliverStoredVideo } from "./managed-save.ts";
import type { StorageTarget } from "../objects/object-store.ts";
import type { StorageWorkerConfig, TransferContext } from "./transfer-context.ts";

export const makeStorageWorker = (database: Database, config: StorageWorkerConfig) => ({
  maintain: Effect.fn("StorageWorker.maintain")(function* () {
    retireExpiredTransfers(database, config.now());
    const pending = database.db
      .select()
      .from(storageTransfers)
      .where(
        and(
          inArray(storageTransfers.state, ["pending", "retry-wait", "uploading", "verifying"]),
          lte(storageTransfers.nextAttemptAt, config.now()),
        ),
      )
      .orderBy(asc(storageTransfers.createdAt))
      .limit(100)
      .all();
    yield* Effect.forEach(pending, (transfer) => runTransfer(database, config, transfer.id), {
      concurrency: 2,
      discard: true,
    });
  }),
});
const runTransfer = Effect.fn("StorageWorker.transfer")(function* (
  database: Database,
  config: StorageWorkerConfig,
  transferId: string,
) {
  const transfer = claimTransfer(database, config, transferId);
  if (transfer === undefined) return;
  const targets = new Map<string, StorageTarget>();
  const scopedConfig = {
    ...config,
    resolveTarget: async (id: string, role: StorageTarget["role"]) => {
      const key = `${id}/${role}`;
      const target = targets.get(key) ?? (await config.resolveTarget(id, role));
      targets.set(key, target);
      return target;
    },
  };
  yield* storagePromise("storage-worker", async (signal) => {
    const context: TransferContext = {
      database,
      config: scopedConfig,
      transfer,
      signal,
      assertActive: () => assertActive(database, transfer, config.now()),
    };
    if (
      (transfer.kind === "save" || transfer.kind === "export") &&
      transfer.recoveryDeadline <= config.now()
    )
      throw storageFailure("STORAGE_RECOVERY_EXPIRED");
    if (transfer.kind === "delete") return deleteStoredVideo(context);
    if (transfer.kind === "visibility") return changeStoredVisibility(context);
    await deliverStoredVideo(context);
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => recordTransferFailure(database, config, transfer, error)),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        targets.forEach((target) => target.store.close());
      }),
    ),
    Effect.ensuring(
      Effect.sync(() =>
        database.db
          .update(storageTransfers)
          .set({ leaseOwner: null, workerPid: null, workerIdentity: null })
          .where(
            and(
              eq(storageTransfers.id, transfer.id),
              eq(storageTransfers.leaseOwner, transfer.leaseOwner ?? ""),
            ),
          )
          .run(),
      ),
    ),
  );
});

const claimTransfer = (database: Database, config: StorageWorkerConfig, transferId: string) =>
  database.db.transaction(
    (transaction) => {
      const row = transaction
        .select()
        .from(storageTransfers)
        .where(eq(storageTransfers.id, transferId))
        .get();
      if (!row || !["pending", "retry-wait", "uploading", "verifying"].includes(row.state))
        return undefined;
      const alive = config.isWriterAlive ?? writerIsAlive;
      if (
        row.workerPid !== null &&
        row.workerIdentity !== null &&
        alive(row.workerPid, row.workerIdentity)
      )
        return undefined;
      const other = transaction
        .select()
        .from(storageTransfers)
        .where(
          and(
            eq(storageTransfers.organizationId, row.organizationId),
            isNotNull(storageTransfers.workerPid),
          ),
        )
        .all()
        .find(
          (candidate) =>
            candidate.id !== row.id &&
            candidate.workerPid !== null &&
            candidate.workerIdentity !== null &&
            alive(candidate.workerPid, candidate.workerIdentity),
        );
      if (other) return undefined;
      return transaction
        .update(storageTransfers)
        .set({
          state: "uploading",
          leaseOwner: randomUUID(),
          workerPid: process.pid,
          workerIdentity: config.writerIdentity ?? writerProcessIdentity(process.pid),
          attempts: row.attempts + 1,
          updatedAt: config.now(),
        })
        .where(eq(storageTransfers.id, row.id))
        .returning()
        .get();
    },
    { behavior: "immediate" },
  );

const assertActive = (
  database: Database,
  transfer: typeof storageTransfers.$inferSelect,
  now: number,
) => {
  const current = database.db
    .select()
    .from(storageTransfers)
    .where(eq(storageTransfers.id, transfer.id))
    .get();
  const organization = database.db
    .select()
    .from(organizations)
    .where(eq(organizations.id, transfer.organizationId))
    .get();
  if (
    !current ||
    current.leaseOwner !== transfer.leaseOwner ||
    current.revision !== transfer.revision ||
    !["uploading", "verifying"].includes(current.state) ||
    (organization?.state !== "active" &&
      !(transfer.kind === "delete" && organization?.state === "deleting"))
  )
    throw storageFailure("STORAGE_BUSY");
  const video = database.db.select().from(videos).where(eq(videos.id, transfer.videoId)).get();
  const connection = video?.connectionId
    ? database.db
        .select()
        .from(storageConnections)
        .where(eq(storageConnections.id, video.connectionId))
        .get()
    : undefined;
  if (
    ["save", "export"].includes(transfer.kind) &&
    video?.connectionId &&
    connection?.state !== "active"
  )
    throw storageFailure("STORAGE_CONNECTION_UNAVAILABLE");
  if ((transfer.kind === "save" || transfer.kind === "export") && current.recoveryDeadline <= now)
    throw storageFailure("STORAGE_RECOVERY_EXPIRED");
};
const recordTransferFailure = (
  database: Database,
  config: StorageWorkerConfig,
  transfer: typeof storageTransfers.$inferSelect,
  error: unknown,
) => {
  const failure =
    error instanceof VideoStorageError ? error : storageFailure("STORAGE_PROVIDER_UNAVAILABLE");
  const retryable =
    transfer.kind === "delete" ||
    transfer.kind === "visibility" ||
    failure.code === "STORAGE_PROVIDER_UNAVAILABLE" ||
    failure.code === "STORAGE_BUSY";
  const expired = failure.code === "STORAGE_RECOVERY_EXPIRED";
  database.db.transaction((transaction) => {
    const current = transaction
      .select()
      .from(storageTransfers)
      .where(eq(storageTransfers.id, transfer.id))
      .get();
    if (
      current?.leaseOwner !== transfer.leaseOwner ||
      current.revision !== transfer.revision ||
      current.state === "succeeded"
    )
      return;
    transaction
      .update(storageTransfers)
      .set({
        state: expired ? "failed" : retryable ? "retry-wait" : "blocked",
        errorCode: failure.code,
        nextAttemptAt: config.now() + Math.min(300_000, 1000 * 2 ** Math.min(transfer.attempts, 8)),
        updatedAt: config.now(),
      })
      .where(eq(storageTransfers.id, transfer.id))
      .run();
    const video = transaction.select().from(videos).where(eq(videos.id, transfer.videoId)).get();
    if (
      !video ||
      video.transferId !== transfer.id ||
      video.visibilityRevision !== transfer.revision
    )
      return;
    transitionVideo(transaction, video, {
      state:
        transfer.kind === "delete"
          ? "deleting"
          : transfer.kind === "visibility"
            ? "visibility-changing"
            : expired
              ? "storage-failed"
              : retryable
                ? "storing"
                : "storage-blocked",
      errorCode: failure.code,
    });
  });
};
