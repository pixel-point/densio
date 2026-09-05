import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "../../database/database.ts";
import {
  storageObjects,
  type storageConnectionOperations,
} from "../../database/video-storage-schema.ts";
import type { ObjectStore } from "../objects/object-store.ts";
import { storageFailure } from "../storage-errors.ts";

export const runConnectionProbe = async (
  database: Database,
  operation: typeof storageConnectionOperations.$inferSelect,
  store: ObjectStore,
  key: string,
  now: () => number,
  assertActive: () => void,
  signal: AbortSignal,
  bucketRole: "staging" | "public" | "private",
) => {
  const bytes = Buffer.from(`densio-storage-probe:${operation.id}`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const object =
    database.db
      .select()
      .from(storageObjects)
      .where(
        and(
          eq(storageObjects.connectionId, operation.connectionId),
          eq(storageObjects.bucket, store.bucket),
          eq(storageObjects.objectKey, key),
        ),
      )
      .get() ??
    database.db
      .insert(storageObjects)
      .values({
        id: randomUUID(),
        organizationId: operation.organizationId,
        connectionId: operation.connectionId,
        targetId: `connection:${operation.connectionId}`,
        bucketRole,
        bucket: store.bucket,
        objectKey: key,
        state: "planned",
        bytes: bytes.length,
        sha256,
        createdAt: now(),
      })
      .returning()
      .get();
  assertActive();
  if ((await store.head(key, undefined, signal)) === null) {
    const uploadId = await probeUpload(database, store, object, assertActive, signal);
    assertActive();
    const etag = await store.uploadPart(key, uploadId, 1, bytes, bytes.length, signal);
    const completed = await store.complete(
      key,
      uploadId,
      [{ partNumber: 1, bytes: bytes.length, etag }],
      signal,
    );
    database.db
      .update(storageObjects)
      .set({ state: "completed", versionId: completed.versionId ?? null })
      .where(eq(storageObjects.id, object.id))
      .run();
  }
  const remote = await store.read(key, undefined, undefined, signal);
  const hash = createHash("sha256");
  let received = 0;
  for await (const chunk of remote.body) {
    received += chunk.length;
    if (received > bytes.length) {
      remote.body.destroy();
      throw storageFailure("STORAGE_OBJECT_CHANGED");
    }
    hash.update(chunk);
  }
  if (received !== bytes.length || hash.digest("hex") !== sha256)
    throw storageFailure("STORAGE_OBJECT_CHANGED");
  return { object, bytes: bytes.length };
};
const probeUpload = async (
  database: Database,
  store: ObjectStore,
  object: typeof storageObjects.$inferSelect,
  assertActive: () => void,
  signal: AbortSignal,
) => {
  if (object.uploadId) return object.uploadId;
  if (object.state === "creating") {
    const sessions = await store.listMultipart(object.objectKey, signal);
    if (sessions.length !== 1 || !sessions[0]) throw storageFailure("STORAGE_BUSY");
    database.db
      .update(storageObjects)
      .set({ uploadId: sessions[0].uploadId, state: "uploading" })
      .where(eq(storageObjects.id, object.id))
      .run();
    return sessions[0].uploadId;
  }
  assertActive();
  database.db
    .update(storageObjects)
    .set({ state: "creating" })
    .where(eq(storageObjects.id, object.id))
    .run();
  const uploadId = await store.createMultipart(
    object.objectKey,
    {
      filename: "probe.bin",
      mediaType: "application/octet-stream",
      sha256: object.sha256,
      public: false,
    },
    signal,
  );
  database.db
    .update(storageObjects)
    .set({ uploadId, state: "uploading" })
    .where(eq(storageObjects.id, object.id))
    .run();
  return uploadId;
};

export const probeMultipartAbort = async (
  database: Database,
  store: ObjectStore,
  source: typeof storageObjects.$inferSelect,
  now: () => number,
  assertActive: () => void,
  signal: AbortSignal,
) => {
  const key = `${source.objectKey}.abort`;
  const object =
    database.db
      .select()
      .from(storageObjects)
      .where(
        and(
          eq(storageObjects.connectionId, source.connectionId!),
          eq(storageObjects.bucket, source.bucket),
          eq(storageObjects.objectKey, key),
        ),
      )
      .get() ??
    database.db
      .insert(storageObjects)
      .values({
        id: randomUUID(),
        organizationId: source.organizationId,
        connectionId: source.connectionId,
        targetId: source.targetId,
        bucketRole: source.bucketRole,
        bucket: source.bucket,
        objectKey: key,
        state: "planned",
        bytes: 0,
        sha256: source.sha256,
        createdAt: now(),
      })
      .returning()
      .get();
  if (object.state === "deleted") return;
  const uploadId = await probeUpload(database, store, object, assertActive, signal);
  assertActive();
  await store.abort(key, uploadId, signal);
  if ((await store.listMultipart(key, signal)).some((session) => session.uploadId === uploadId))
    throw storageFailure("STORAGE_DELETION_BLOCKED");
  database.db
    .update(storageObjects)
    .set({ state: "deleted", deletedAt: now() })
    .where(eq(storageObjects.id, object.id))
    .run();
};
