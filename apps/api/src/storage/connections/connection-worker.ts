import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import { Effect } from "effect";
import type { Database } from "../../database/database.ts";
import {
  sourceObjectUploads,
  storageConnections,
  storageConnectionOperations,
  storageObjectReads,
  storageObjects,
  storageTransfers,
  videos,
} from "../../database/video-storage-schema.ts";
import { writerIsAlive, writerProcessIdentity } from "../../services/writer-process.ts";
import { transitionVideo } from "../../videos/video-lifecycle.ts";
import { connectionInputTransfers } from "../transfers/object-consumers.ts";
import { publicObjectUrl } from "../../videos/video-catalog.ts";
import { storageFailure, storagePromise, VideoStorageError } from "../storage-errors.ts";
import { connectionRow } from "./connection-catalog.ts";
import { probeMultipartAbort, runConnectionProbe } from "./connection-probe.ts";
import {
  anonymousStorageUrl,
  openConnectionStores,
  verifyConnectionAccess,
  type ConnectionProviderConfig,
} from "./connection-store.ts";

export const makeConnectionWorker = (database: Database, config: ConnectionProviderConfig) => ({
  maintain: Effect.fn("StorageConnections.maintain")(function* () {
    const pending = database.db
      .select()
      .from(storageConnectionOperations)
      .where(inArray(storageConnectionOperations.state, ["pending", "running"]))
      .limit(25)
      .all();
    for (const operation of pending) yield* processOperation(database, config, operation);
  }),
});
const processOperation = Effect.fn("StorageConnections.operation")(function* (
  database: Database,
  config: ConnectionProviderConfig,
  candidate: typeof storageConnectionOperations.$inferSelect,
) {
  const operation = claimOperation(database, config, candidate.id);
  if (!operation) return;
  yield* storagePromise("connection-worker", async (signal) => {
    const row = connectionRow(database, operation.organizationId, operation.connectionId);
    if (operation.kind === "disconnect" || operation.kind === "disable")
      return disconnectConnection(database, config, operation, signal);
    const stores = openConnectionStores(
      row,
      config,
      operation.candidateCiphertext && operation.credentialVersion
        ? {
            ciphertext: operation.candidateCiphertext,
            version: operation.credentialVersion,
            keyVersion: operation.candidateKeyVersion ?? row.encryptionKeyVersion,
          }
        : undefined,
    );
    const assertActive = () => {
      const current = database.db
        .select()
        .from(storageConnectionOperations)
        .where(eq(storageConnectionOperations.id, operation.id))
        .get();
      if (current?.leaseOwner !== operation.leaseOwner || current.state !== "running")
        throw storageFailure("STORAGE_BUSY");
    };
    await validateStores(database, config, operation, stores, assertActive, signal).finally(() => {
      stores.output.close();
      stores.staging?.close();
    });
    assertActive();
    database.db.transaction((transaction) => {
      transaction
        .update(storageConnections)
        .set({
          state: "active",
          errorCode: null,
          validatedAt: config.now(),
          updatedAt: config.now(),
          ...(operation.kind === "rotate"
            ? {
                credentialsCiphertext: operation.candidateCiphertext,
                credentialVersion: operation.credentialVersion ?? row.credentialVersion,
                encryptionKeyVersion: operation.candidateKeyVersion ?? row.encryptionKeyVersion,
              }
            : {}),
        })
        .where(eq(storageConnections.id, row.id))
        .run();
      transaction
        .update(storageConnectionOperations)
        .set({ state: "succeeded", candidateCiphertext: null, updatedAt: config.now() })
        .where(eq(storageConnectionOperations.id, operation.id))
        .run();
    });
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        const code =
          error instanceof VideoStorageError ? error.code : "STORAGE_PROVIDER_UNAVAILABLE";
        database.db
          .update(storageConnectionOperations)
          .set({ state: "blocked", errorCode: code, updatedAt: config.now() })
          .where(eq(storageConnectionOperations.id, operation.id))
          .run();
        if (operation.kind === "validate")
          database.db
            .update(storageConnections)
            .set({ state: "error", errorCode: code })
            .where(eq(storageConnections.id, operation.connectionId))
            .run();
      }),
    ),
    Effect.ensuring(
      Effect.sync(() =>
        database.db
          .update(storageConnectionOperations)
          .set({ workerPid: null, workerIdentity: null, leaseOwner: null })
          .where(eq(storageConnectionOperations.id, operation.id))
          .run(),
      ),
    ),
  );
});
const claimOperation = (database: Database, config: ConnectionProviderConfig, id: string) =>
  database.db.transaction(
    (transaction) => {
      const row = transaction
        .select()
        .from(storageConnectionOperations)
        .where(eq(storageConnectionOperations.id, id))
        .get();
      if (!row || !["pending", "running"].includes(row.state)) return undefined;
      if (
        row.workerPid !== null &&
        row.workerIdentity !== null &&
        (config.isWriterAlive ?? writerIsAlive)(row.workerPid, row.workerIdentity)
      )
        return undefined;
      return transaction
        .update(storageConnectionOperations)
        .set({
          state: "running",
          workerPid: process.pid,
          workerIdentity: config.writerIdentity ?? writerProcessIdentity(process.pid),
          leaseOwner: randomUUID(),
        })
        .where(eq(storageConnectionOperations.id, id))
        .returning()
        .get();
    },
    { behavior: "immediate" },
  );

const validateStores = async (
  database: Database,
  config: ConnectionProviderConfig,
  operation: typeof storageConnectionOperations.$inferSelect,
  stores: ReturnType<typeof openConnectionStores>,
  assertActive: () => void,
  signal: AbortSignal,
) => {
  const definition = stores.definition;
  const targets = [
    {
      store: stores.output,
      location: definition.location,
      publicBaseUrl: definition.publicBaseUrl,
      publicRead: definition.visibility === "public",
      suffix: "output",
      role: definition.visibility,
    },
    ...(stores.staging && definition.staging
      ? [
          {
            store: stores.staging,
            location: definition.staging,
            publicBaseUrl: definition.stagingPublicBaseUrl,
            publicRead: false,
            suffix: "staging",
            role: "staging" as const,
          },
        ]
      : []),
  ];
  for (const target of targets) {
    const key = [
      target.location.prefix,
      "densio",
      operation.organizationId,
      operation.connectionId,
      "probes",
      `${operation.id}-${target.suffix}.bin`,
    ]
      .filter(Boolean)
      .join("/");
    const result = await runConnectionProbe(
      database,
      operation,
      target.store,
      key,
      config.now,
      assertActive,
      signal,
      target.role,
    );
    const url = target.publicBaseUrl
      ? publicObjectUrl(target.publicBaseUrl, key)
      : anonymousStorageUrl(target.location, key);
    await verifyConnectionAccess(url, target.publicRead, result.bytes, config, signal);
    assertActive();
    const current = database.db
      .select()
      .from(storageObjects)
      .where(eq(storageObjects.id, result.object.id))
      .get();
    if (current?.uploadId) await target.store.abort(key, current.uploadId, signal);
    await target.store.remove(key, current?.versionId ?? undefined, signal);
    if ((await target.store.head(key, current?.versionId ?? undefined, signal)) !== null)
      throw storageFailure("STORAGE_DELETION_BLOCKED");
    database.db
      .update(storageObjects)
      .set({ state: "deleted", deletedAt: config.now() })
      .where(eq(storageObjects.id, result.object.id))
      .run();
    await probeMultipartAbort(
      database,
      target.store,
      result.object,
      config.now,
      assertActive,
      signal,
    );
  }
};

const disconnectConnection = async (
  database: Database,
  config: ConnectionProviderConfig,
  operation: typeof storageConnectionOperations.$inferSelect,
  signal: AbortSignal,
) => {
  const live = connectionHasWriters(database, config, operation);
  if (live) {
    database.db
      .update(storageConnectionOperations)
      .set({ state: "pending" })
      .where(eq(storageConnectionOperations.id, operation.id))
      .run();
    return;
  }
  if (operation.kind === "disable") {
    database.db
      .update(storageConnectionOperations)
      .set({ state: "succeeded" })
      .where(eq(storageConnectionOperations.id, operation.id))
      .run();
    return;
  }
  const pending = database.db
    .select()
    .from(storageObjects)
    .where(
      and(
        eq(storageObjects.connectionId, operation.connectionId),
        ne(storageObjects.state, "deleted"),
      ),
    )
    .all();
  const row = connectionRow(database, operation.organizationId, operation.connectionId);
  const stores = await Promise.resolve()
    .then(() => openConnectionStores(row, config))
    .catch(() => undefined);
  const cleanupRequired: { bucket: string; key: string; uploadId?: string }[] = [];
  for (const object of pending) {
    const video = object.videoId
      ? database.db.select().from(videos).where(eq(videos.id, object.videoId)).get()
      : undefined;
    if (
      video?.storedAt !== null &&
      video?.storedAt !== undefined &&
      object.bucketRole !== "staging"
    )
      continue;
    const store =
      object.bucketRole === "staging" ? (stores?.staging ?? stores?.output) : stores?.output;
    const removed = await Promise.resolve()
      .then(async () => {
        if (!store) return false;
        if (object.state === "creating" && !object.uploadId) return false;
        if (object.uploadId) await store.abort(object.objectKey, object.uploadId, signal);
        await store.remove(object.objectKey, object.versionId ?? undefined, signal);
        return (await store.head(object.objectKey, object.versionId ?? undefined, signal)) === null;
      })
      .catch(() => false);
    if (removed)
      database.db
        .update(storageObjects)
        .set({ state: "deleted", deletedAt: config.now() })
        .where(eq(storageObjects.id, object.id))
        .run();
    if (!removed)
      cleanupRequired.push({
        bucket: object.bucket,
        key: object.objectKey,
        ...(object.uploadId ? { uploadId: object.uploadId } : {}),
      });
  }
  stores?.output.close();
  stores?.staging?.close();
  finishDisconnect(database, operation, cleanupRequired, config.now());
};

const connectionHasWriters = (
  database: Database,
  config: ConnectionProviderConfig,
  operation: typeof storageConnectionOperations.$inferSelect,
) => {
  const alive = config.isWriterAlive ?? writerIsAlive;
  const live = database.db
    .select({ transfer: storageTransfers })
    .from(storageTransfers)
    .innerJoin(videos, eq(videos.id, storageTransfers.videoId))
    .where(eq(videos.connectionId, operation.connectionId))
    .all()
    .some(
      ({ transfer }) =>
        transfer.workerPid !== null &&
        transfer.workerIdentity !== null &&
        alive(transfer.workerPid, transfer.workerIdentity),
    );
  const sourceLive = database.db
    .select()
    .from(sourceObjectUploads)
    .where(eq(sourceObjectUploads.connectionId, operation.connectionId))
    .all()
    .some(
      (row) =>
        row.workerPid !== null &&
        row.workerIdentity !== null &&
        alive(row.workerPid, row.workerIdentity),
    );
  const operationLive = database.db
    .select()
    .from(storageConnectionOperations)
    .where(
      and(
        eq(storageConnectionOperations.connectionId, operation.connectionId),
        ne(storageConnectionOperations.id, operation.id),
      ),
    )
    .all()
    .some(
      (row) =>
        row.workerPid !== null &&
        row.workerIdentity !== null &&
        alive(row.workerPid, row.workerIdentity),
    );
  const readLive = database.db
    .select({ read: storageObjectReads })
    .from(storageObjectReads)
    .innerJoin(storageObjects, eq(storageObjects.id, storageObjectReads.objectId))
    .where(eq(storageObjects.connectionId, operation.connectionId))
    .all()
    .some(({ read }) => alive(read.workerPid, read.workerIdentity));
  const inputLive = connectionInputTransfers(database.db, operation.connectionId).some(
    (transfer) =>
      transfer.workerPid !== null &&
      transfer.workerIdentity !== null &&
      alive(transfer.workerPid, transfer.workerIdentity),
  );
  return live || sourceLive || operationLive || readLive || inputLive;
};

const finishDisconnect = (
  database: Database,
  operation: typeof storageConnectionOperations.$inferSelect,
  cleanupRequired: readonly { bucket: string; key: string; uploadId?: string }[],
  now: number,
) => {
  database.db.transaction((transaction) => {
    transaction
      .update(storageConnectionOperations)
      .set({ candidateCiphertext: null })
      .where(eq(storageConnectionOperations.connectionId, operation.connectionId))
      .run();
    transaction
      .update(storageConnections)
      .set({ state: "disconnected", credentialsCiphertext: null, updatedAt: now })
      .where(eq(storageConnections.id, operation.connectionId))
      .run();
    transaction
      .select()
      .from(videos)
      .where(eq(videos.connectionId, operation.connectionId))
      .all()
      .forEach((video) =>
        transitionVideo(transaction, video, {
          state: "unavailable",
          errorCode: "STORAGE_CONNECTION_UNAVAILABLE",
        }),
      );
    transaction
      .update(storageConnectionOperations)
      .set({
        state: "succeeded",
        candidateCiphertext: null,
        progressJson: JSON.stringify({ cleanupRequired }),
        updatedAt: now,
      })
      .where(eq(storageConnectionOperations.id, operation.id))
      .run();
  });
};
