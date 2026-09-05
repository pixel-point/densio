import { and, eq, isNull } from "drizzle-orm";
import { Effect, Result } from "effect";
import type { Database, DatabaseTransaction } from "../../database/database.ts";
import { organizations, preparedSources } from "../../database/schema.ts";
import {
  sourceObjectUploads,
  storageConnections,
  storageConnectionOperations,
  storageObjects,
  storageTransfers,
  videos,
} from "../../database/video-storage-schema.ts";
import { canonicalDigest } from "../../idempotency/canonical-digest.ts";
import { writerIsAlive } from "../../services/writer-process.ts";
import type { StorageTarget } from "../objects/object-store.ts";

type ObjectRow = typeof storageObjects.$inferSelect;
export interface StorageRecoveryDependencies {
  readonly resolveTarget: (id: string, role: StorageTarget["role"]) => Promise<StorageTarget>;
  readonly isWriterAlive?: typeof writerIsAlive;
}

export const inspectUncertainUploads = (database: Database, organizationId: string) =>
  database.db
    .select()
    .from(storageObjects)
    .where(
      and(
        eq(storageObjects.organizationId, organizationId),
        eq(storageObjects.state, "creating"),
        isNull(storageObjects.uploadId),
      ),
    )
    .all()
    .map((object) => ({
      objectId: object.id,
      targetId: object.targetId,
      bucketRole: object.bucketRole,
      snapshotDigest: canonicalDigest(recoverySnapshot(database.db, object)),
    }));

export const reconcileUncertainUpload = async (
  database: Database,
  organizationId: string,
  objectId: string,
  dependencies: StorageRecoveryDependencies,
) => {
  const object = database.db
    .select()
    .from(storageObjects)
    .where(and(eq(storageObjects.id, objectId), eq(storageObjects.organizationId, organizationId)))
    .get();
  if (!object) return { objectId, outcome: "not-found" as const };
  if (object.state !== "creating" || object.uploadId !== null)
    return { objectId, outcome: "not-uncertain" as const };
  const snapshot = recoverySnapshot(database.db, object);
  const snapshotDigest = canonicalDigest(snapshot);
  const base = { objectId, snapshotDigest };
  if (hasWriter(snapshot, dependencies)) return { ...base, outcome: "writer-active" as const };
  const evidence = await Effect.runPromise(
    Effect.tryPromise(async () => {
      const target = await dependencies.resolveTarget(object.targetId, object.bucketRole);
      try {
        if (
          target.id !== object.targetId ||
          target.role !== object.bucketRole ||
          target.store.bucket !== object.bucket
        )
          return { kind: "target-mismatch" as const };
        const signal = AbortSignal.timeout(120_000);
        const present = await target.store.head(
          object.objectKey,
          object.versionId ?? undefined,
          signal,
        );
        const uploads = await target.store.listMultipart(object.objectKey, signal);
        return {
          kind: "observed" as const,
          present: present !== null,
          uploadIds: [
            ...new Set(
              uploads
                .filter((upload) => upload.key === object.objectKey && upload.uploadId.length > 0)
                .map((upload) => upload.uploadId),
            ),
          ],
        };
      } finally {
        target.store.close();
      }
    }).pipe(Effect.result),
  );
  if (Result.isFailure(evidence)) return { ...base, outcome: "provider-unavailable" as const };
  if (evidence.success.kind === "target-mismatch")
    return { ...base, outcome: "target-mismatch" as const };
  const { present, uploadIds } = evidence.success;
  const observed = { ...base, objectPresent: present, multipartCount: uploadIds.length };
  if (present) return { ...observed, outcome: "object-present" as const };
  if (uploadIds.length !== 1)
    return {
      ...observed,
      outcome: uploadIds.length ? ("ambiguous" as const) : ("no-evidence" as const),
    };
  return database.db.transaction(
    (transaction) => {
      const current = transaction
        .select()
        .from(storageObjects)
        .where(eq(storageObjects.id, object.id))
        .get();
      if (!current) return { ...observed, outcome: "changed" as const };
      const latest = recoverySnapshot(transaction, current);
      if (canonicalDigest(latest) !== snapshotDigest || hasWriter(latest, dependencies))
        return { ...observed, outcome: "changed" as const };
      transaction
        .update(storageObjects)
        .set({ state: "uploading", uploadId: uploadIds[0]! })
        .where(eq(storageObjects.id, object.id))
        .run();
      return { ...observed, outcome: "adopted" as const };
    },
    { behavior: "immediate" },
  );
};

// Include every current and historical owner: object.transferId alone misses later deletion work.
const recoverySnapshot = (transaction: Database["db"] | DatabaseTransaction, object: ObjectRow) => {
  const sources = transaction
    .select()
    .from(sourceObjectUploads)
    .where(eq(sourceObjectUploads.objectId, object.id))
    .all();
  return {
    object,
    organization:
      transaction
        .select()
        .from(organizations)
        .where(eq(organizations.id, object.organizationId))
        .get() ?? null,
    video: object.videoId
      ? (transaction.select().from(videos).where(eq(videos.id, object.videoId)).get() ?? null)
      : null,
    transfers: object.videoId
      ? transaction
          .select()
          .from(storageTransfers)
          .where(eq(storageTransfers.videoId, object.videoId))
          .orderBy(storageTransfers.id)
          .all()
      : [],
    sources,
    preparedSources: sources.map(
      (source) =>
        transaction
          .select()
          .from(preparedSources)
          .where(eq(preparedSources.id, source.sourceId))
          .get() ?? null,
    ),
    connection: object.connectionId
      ? (transaction
          .select()
          .from(storageConnections)
          .where(eq(storageConnections.id, object.connectionId))
          .get() ?? null)
      : null,
    operations: object.connectionId
      ? transaction
          .select()
          .from(storageConnectionOperations)
          .where(eq(storageConnectionOperations.connectionId, object.connectionId))
          .orderBy(storageConnectionOperations.id)
          .all()
      : [],
  };
};
const hasWriter = (
  snapshot: ReturnType<typeof recoverySnapshot>,
  dependencies: StorageRecoveryDependencies,
) =>
  [...snapshot.transfers, ...snapshot.sources, ...snapshot.operations].some((owner) => {
    if (owner.workerPid === null && owner.workerIdentity === null && owner.leaseOwner === null)
      return false;
    if (owner.workerPid === null || owner.workerIdentity === null) return true;
    const alive = Result.try(() =>
      (dependencies.isWriterAlive ?? writerIsAlive)(owner.workerPid!, owner.workerIdentity!),
    );
    return Result.isFailure(alive) || alive.success;
  });
