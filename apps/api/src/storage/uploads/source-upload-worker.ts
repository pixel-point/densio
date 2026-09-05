import { extendSourceIngestionDeadline } from "../../sources/source-ingestion-state.ts";
import {
  assertSourceUploadActive,
  sourceUploadExpired,
  finishUnusableSource,
  failSourceUpload,
} from "../../sources/source-ingestion-state.ts";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq, lte, ne } from "drizzle-orm";
import { Effect } from "effect";
import type { Database } from "../../database/database.ts";
import { organizationMemberships, preparedSources } from "../../database/schema.ts";
import { sourceObjectUploads, storageObjects } from "../../database/video-storage-schema.ts";
import { writerIsAlive, writerProcessIdentity } from "../../services/writer-process.ts";
import { storageFailure, storagePromise, VideoStorageError } from "../storage-errors.ts";
import type { ObjectStore } from "../objects/object-store.ts";
import type { SourceUploadConfig } from "./source-upload-config.ts";

export const makeSourceUploadWorker = (database: Database, config: SourceUploadConfig) => ({
  maintain: Effect.fn("SourceStorage.maintain")(function* () {
    const pending = database.db
      .select({ session: sourceObjectUploads })
      .from(sourceObjectUploads)
      .innerJoin(storageObjects, eq(storageObjects.id, sourceObjectUploads.objectId))
      .where(
        and(
          ne(storageObjects.state, "deleted"),
          lte(sourceObjectUploads.nextAttemptAt, config.now()),
        ),
      )
      .limit(50)
      .all();
    for (const { session } of pending) yield* processUpload(database, config, session.sourceId);
  }),
});
const processUpload = Effect.fn("SourceStorage.process")(function* (
  database: Database,
  config: SourceUploadConfig,
  id: string,
) {
  const session = claimUpload(database, config, id);
  if (!session) return;
  yield* storagePromise("source-upload-worker", async (signal) => {
    const object = database.db
      .select()
      .from(storageObjects)
      .where(eq(storageObjects.id, session.objectId))
      .get();
    const source = database.db
      .select()
      .from(preparedSources)
      .where(eq(preparedSources.id, id))
      .get();
    if (!object || !source) throw storageFailure("STORAGE_OBJECT_CHANGED");
    const expired = sourceUploadExpired(database, session, config.now());
    const target = await config.resolveTarget(object.targetId, "staging");
    await Promise.resolve()
      .then(async () => {
        if (
          expired ||
          ["failed", "expired", "ready"].includes(session.state) ||
          source.state === "ready"
        ) {
          await removeSourceObject(database, object, target.store, config.now(), signal);
          if (source.state !== "ready")
            finishUnusableSource(
              database,
              session,
              session.state === "failed" ? "failed" : "expired",
              config.now(),
            );
          database.db
            .update(sourceObjectUploads)
            .set({
              state:
                source.state === "ready"
                  ? "ready"
                  : session.state === "failed"
                    ? "failed"
                    : "expired",
            })
            .where(eq(sourceObjectUploads.sourceId, id))
            .run();
          return;
        }
        assertSourceUploadActive(database, session, config.now());
        if (session.state === "creating")
          return beginMultipartSource(database, config, session, object, target.store, signal);
        if (session.state === "uploading") {
          database.db
            .update(sourceObjectUploads)
            .set({ nextAttemptAt: session.expiresAt })
            .where(eq(sourceObjectUploads.sourceId, id))
            .run();
          return;
        }
        const current =
          session.state === "committing"
            ? await completeSourceObject(database, config, session, object, target.store, signal)
            : object;
        await importSourceObject(database, config, session, current, target.store, signal);
      })
      .finally(() => target.store.close());
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        const code =
          error instanceof VideoStorageError ? error.code : "STORAGE_PROVIDER_UNAVAILABLE";
        failSourceUpload(database, session, code, config.now());
      }),
    ),
    Effect.ensuring(
      Effect.sync(() =>
        database.db
          .update(sourceObjectUploads)
          .set({ workerPid: null, workerIdentity: null, leaseOwner: null })
          .where(
            and(
              eq(sourceObjectUploads.sourceId, id),
              eq(sourceObjectUploads.leaseOwner, session.leaseOwner!),
            ),
          )
          .run(),
      ),
    ),
  );
});
const claimUpload = (database: Database, config: SourceUploadConfig, id: string) =>
  database.db.transaction(
    (transaction) => {
      const row = transaction
        .select()
        .from(sourceObjectUploads)
        .where(eq(sourceObjectUploads.sourceId, id))
        .get();
      if (
        !row ||
        (row.workerPid !== null &&
          row.workerIdentity !== null &&
          (config.isWriterAlive ?? writerIsAlive)(row.workerPid, row.workerIdentity))
      )
        return undefined;
      return transaction
        .update(sourceObjectUploads)
        .set({
          workerPid: process.pid,
          workerIdentity: config.writerIdentity ?? writerProcessIdentity(process.pid),
          leaseOwner: randomUUID(),
        })
        .where(eq(sourceObjectUploads.sourceId, id))
        .returning()
        .get();
    },
    { behavior: "immediate" },
  );

const beginMultipartSource = async (
  database: Database,
  config: SourceUploadConfig,
  session: typeof sourceObjectUploads.$inferSelect,
  object: typeof storageObjects.$inferSelect,
  store: ObjectStore,
  signal: AbortSignal,
) => {
  const sessions =
    object.state === "creating" && !object.uploadId
      ? await store.listMultipart(object.objectKey, signal)
      : [];
  if (object.state === "creating" && !object.uploadId && sessions.length !== 1)
    throw storageFailure("STORAGE_BUSY");
  database.db
    .update(storageObjects)
    .set({ state: "creating" })
    .where(eq(storageObjects.id, object.id))
    .run();
  const uploadId =
    object.uploadId ??
    sessions[0]?.uploadId ??
    (await store.createMultipart(
      object.objectKey,
      { filename: "source", mediaType: "application/octet-stream", sha256: "", public: false },
      signal,
    ));
  database.db
    .update(storageObjects)
    .set({ state: "uploading", uploadId })
    .where(eq(storageObjects.id, object.id))
    .run();
  assertSourceUploadActive(database, session, config.now());
  database.db
    .update(sourceObjectUploads)
    .set({ state: "uploading", errorCode: null, nextAttemptAt: session.expiresAt })
    .where(eq(sourceObjectUploads.sourceId, session.sourceId))
    .run();
  if (session.expiresAt <= config.now()) throw storageFailure("STORAGE_ACCESS_EXPIRED");
};
const completeSourceObject = async (
  database: Database,
  config: SourceUploadConfig,
  session: typeof sourceObjectUploads.$inferSelect,
  object: typeof storageObjects.$inferSelect,
  store: ObjectStore,
  signal: AbortSignal,
) => {
  const existing = await store.head(object.objectKey, object.versionId ?? undefined, signal);
  if (!existing) {
    if (!object.uploadId) throw storageFailure("STORAGE_OBJECT_CHANGED");
    const parts = await store.listParts(object.objectKey, object.uploadId, signal);
    if (
      parts.length !== Math.ceil(session.declaredBytes / session.partSize) ||
      parts.some(
        (part, index) =>
          part.partNumber !== index + 1 ||
          part.bytes !==
            Math.min(session.partSize, session.declaredBytes - index * session.partSize),
      )
    )
      throw storageFailure(
        "STORAGE_OBJECT_CHANGED",
        "Uploaded multipart inventory does not match the declared source.",
      );
    assertSourceUploadActive(database, session, config.now());
    const completed = await store.complete(object.objectKey, object.uploadId, parts, signal);
    database.db
      .update(storageObjects)
      .set({ versionId: completed.versionId ?? null })
      .where(eq(storageObjects.id, object.id))
      .run();
  }
  const current = database.db
    .select()
    .from(storageObjects)
    .where(eq(storageObjects.id, object.id))
    .get()!;
  const facts = await store.head(object.objectKey, current.versionId ?? undefined, signal);
  if (!facts || facts.bytes !== session.declaredBytes)
    throw storageFailure("STORAGE_OBJECT_CHANGED");
  return database.db.transaction((transaction) => {
    assertSourceUploadActive(database, session, config.now());
    transaction
      .update(sourceObjectUploads)
      .set({ state: "preparing", errorCode: null, nextAttemptAt: config.now() })
      .where(eq(sourceObjectUploads.sourceId, session.sourceId))
      .run();
    const source = transaction
      .select()
      .from(preparedSources)
      .where(eq(preparedSources.id, session.sourceId))
      .get()!;
    extendSourceIngestionDeadline(transaction, source);
    return transaction
      .update(storageObjects)
      .set({
        state: "completed",
        etag: facts.etag,
        versionId: facts.versionId ?? current.versionId,
      })
      .where(eq(storageObjects.id, object.id))
      .returning()
      .get();
  });
};
const importSourceObject = async (
  database: Database,
  config: SourceUploadConfig,
  session: typeof sourceObjectUploads.$inferSelect,
  object: typeof storageObjects.$inferSelect,
  store: ObjectStore,
  signal: AbortSignal,
) => {
  assertSourceUploadActive(database, session, config.now());
  const membership = database.db
    .select()
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.id, session.membershipId),
        eq(organizationMemberships.organizationId, session.organizationId),
      ),
    )
    .get();
  if (!membership) throw storageFailure("STORAGE_ACCESS_EXPIRED");
  const remote = await store.read(
    object.objectKey,
    undefined,
    object.versionId ?? undefined,
    signal,
  );
  if (remote.bytes !== session.declaredBytes || remote.etag !== object.etag) {
    remote.body.destroy();
    throw storageFailure("STORAGE_OBJECT_CHANGED");
  }
  const source = await Effect.runPromise(
    config.sourceService.ingestObject({
      organizationId: session.organizationId,
      userId: membership.userId,
      membershipId: membership.id,
      sourceId: session.sourceId,
      storageObjectId: object.id,
      body: Readable.toWeb(remote.body),
      now: config.now(),
      correlationId: "storage-source",
    }),
    { signal },
  ).finally(() => remote.body.destroy());
  if (source.state !== "ready" && source.state !== "failed") throw storageFailure("STORAGE_BUSY");
  database.db
    .update(sourceObjectUploads)
    .set({
      state: source.state,
      errorCode: source.state === "failed" ? "SOURCE_INSPECTION_FAILED" : null,
    })
    .where(eq(sourceObjectUploads.sourceId, session.sourceId))
    .run();
  await removeSourceObject(database, object, store, config.now(), signal);
};
export const removeSourceObject = async (
  database: Database,
  object: typeof storageObjects.$inferSelect,
  store: ObjectStore,
  now: number,
  signal: AbortSignal,
) => {
  if (object.uploadId) await store.abort(object.objectKey, object.uploadId, signal);
  const pending =
    object.state === "creating" ? await store.listMultipart(object.objectKey, signal) : [];
  if (object.state === "creating" && !object.uploadId && pending.length === 0)
    throw storageFailure("STORAGE_BUSY");
  for (const session of pending) await store.abort(object.objectKey, session.uploadId, signal);
  await store.remove(object.objectKey, object.versionId ?? undefined, signal);
  if ((await store.head(object.objectKey, object.versionId ?? undefined, signal)) !== null)
    throw storageFailure("STORAGE_DELETION_BLOCKED");
  database.db
    .update(storageObjects)
    .set({ state: "deleted", deletedAt: now })
    .where(eq(storageObjects.id, object.id))
    .run();
};
