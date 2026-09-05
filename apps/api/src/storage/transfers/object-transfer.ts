import { MULTIPART_PART_BYTES } from "../objects/multipart-policy.ts";
import { type StorageFile } from "./storage-files.ts";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { and, eq } from "drizzle-orm";
import { storageObjects, videos } from "../../database/video-storage-schema.ts";
import { publicObjectUrl } from "../../videos/video-catalog.ts";
import { storageFailure } from "../storage-errors.ts";
import type { ObjectPart, StorageTarget } from "../objects/object-store.ts";
import type { TransferContext } from "./transfer-context.ts";

export type TransferSource =
  | { readonly path: string; readonly expiresAt: number }
  | { readonly target: StorageTarget; readonly object: typeof storageObjects.$inferSelect };

export const prepareObject = (
  context: TransferContext,
  target: StorageTarget,
  variant: StorageFile,
  key: string,
) => {
  const existing = context.database.db
    .select()
    .from(storageObjects)
    .where(
      and(
        eq(storageObjects.targetId, target.id),
        eq(storageObjects.bucket, target.store.bucket),
        eq(storageObjects.objectKey, key),
      ),
    )
    .get();
  if (existing !== undefined) return existing;
  context.assertActive();
  return context.database.db
    .insert(storageObjects)
    .values({
      connectionId:
        context.database.db.select().from(videos).where(eq(videos.id, variant.videoId)).get()
          ?.connectionId ?? null,
      id: randomUUID(),
      organizationId: variant.organizationId,
      videoId: variant.videoId,
      variantId: variant.kind === "variant" ? variant.id : null,
      packageMemberId: variant.kind === "hls" ? variant.id : null,
      transferId: context.transfer.id,
      targetId: target.id,
      bucketRole: target.role,
      bucket: target.store.bucket,
      objectKey: key,
      publicUrl:
        target.role === "public" && target.publicOrigin
          ? publicObjectUrl(target.publicOrigin, key)
          : null,
      state: "planned",
      bytes: variant.bytes,
      sha256: variant.sha256,
      revision: context.transfer.revision,
      createdAt: context.config.now(),
    })
    .returning()
    .get();
};

export const transferObject = async (
  context: TransferContext,
  target: StorageTarget,
  initial: typeof storageObjects.$inferSelect,
  variant: StorageFile,
  source: TransferSource,
) => {
  context.assertActive();
  if (["completed", "verified"].includes(initial.state))
    return verifyObject(context, target, initial);
  const present =
    initial.state === "planned"
      ? null
      : await target.store.head(initial.objectKey, initial.versionId ?? undefined, context.signal);
  if (present !== null) return verifyObject(context, target, initial);
  if (variant.kind === "hls" && variant.bytes <= 8 * 1024 * 1024)
    return putSmallObject(context, target, initial, variant, source);
  const uploadId = await acquireUpload(context, target, initial, variant);
  const uploaded = await target.store.listParts(initial.objectKey, uploadId, context.signal);
  const parts: ObjectPart[] = [];
  for (let start = 0; start < variant.bytes; start += MULTIPART_PART_BYTES) {
    context.assertActive();
    const partNumber = Math.floor(start / MULTIPART_PART_BYTES) + 1;
    const end = Math.min(start + MULTIPART_PART_BYTES, variant.bytes) - 1;
    const existing = uploaded.find(
      (part) => part.partNumber === partNumber && part.bytes === end - start + 1,
    );
    const etag =
      existing?.etag ??
      (await writePart(
        context,
        target,
        initial.objectKey,
        uploadId,
        partNumber,
        source,
        start,
        end,
      ));
    parts.push({ partNumber, bytes: end - start + 1, etag });
    context.database.db
      .update(storageObjects)
      .set({ partsJson: JSON.stringify(parts) })
      .where(eq(storageObjects.id, initial.id))
      .run();
  }
  context.assertActive();
  const completed = await target.store.complete(initial.objectKey, uploadId, parts, context.signal);
  context.database.db
    .update(storageObjects)
    .set({ state: "completed", versionId: completed.versionId ?? null })
    .where(eq(storageObjects.id, initial.id))
    .run();
  return verifyObject(context, target, { ...initial, versionId: completed.versionId ?? null });
};

const putSmallObject = async (
  context: TransferContext,
  target: StorageTarget,
  object: typeof storageObjects.$inferSelect,
  file: StorageFile,
  source: TransferSource,
) => {
  context.assertActive();
  context.database.db
    .update(storageObjects)
    .set({ state: "uploading" })
    .where(eq(storageObjects.id, object.id))
    .run();
  const body =
    "path" in source
      ? await localSourcePart(context, source, 0, file.bytes - 1)
      : (
          await source.target.store.read(
            source.object.objectKey,
            undefined,
            source.object.versionId ?? undefined,
            context.signal,
          )
        ).body;
  const completed = await target.store
    .put(
      object.objectKey,
      {
        mediaType: file.mediaType,
        filename: file.filename,
        sha256: file.sha256,
        public: target.role === "public",
      },
      body,
      file.bytes,
      context.signal,
    )
    .finally(() => body.destroy());
  context.assertActive();
  context.database.db
    .update(storageObjects)
    .set({ state: "completed", versionId: completed.versionId ?? null })
    .where(eq(storageObjects.id, object.id))
    .run();
  return verifyObject(context, target, { ...object, versionId: completed.versionId ?? null });
};

const acquireUpload = async (
  context: TransferContext,
  target: StorageTarget,
  object: typeof storageObjects.$inferSelect,
  variant: StorageFile,
) => {
  if (object.uploadId !== null) return object.uploadId;
  if (object.state === "creating") {
    const sessions = await target.store.listMultipart(object.objectKey, context.signal);
    if (sessions.length !== 1 || !sessions[0])
      throw storageFailure(
        "STORAGE_BUSY",
        "An uncertain multipart creation must be reconciled before retrying.",
      );
    return recordUpload(context, object.id, sessions[0].uploadId);
  }
  context.assertActive();
  context.database.db
    .update(storageObjects)
    .set({ state: "creating" })
    .where(eq(storageObjects.id, object.id))
    .run();
  const uploadId = await target.store.createMultipart(
    object.objectKey,
    {
      mediaType: variant.mediaType,
      filename: variant.filename,
      sha256: variant.sha256,
      public: target.role === "public",
    },
    context.signal,
  );
  return recordUpload(context, object.id, uploadId);
};
const recordUpload = (context: TransferContext, objectId: string, uploadId: string) => {
  context.database.db
    .update(storageObjects)
    .set({ state: "uploading", uploadId })
    .where(eq(storageObjects.id, objectId))
    .run();
  return uploadId;
};

export const verifyObject = async (
  context: TransferContext,
  target: StorageTarget,
  object: typeof storageObjects.$inferSelect,
) => {
  const facts = await target.store.head(
    object.objectKey,
    object.versionId ?? undefined,
    context.signal,
  );
  if (facts === null || facts.bytes !== object.bytes)
    throw storageFailure("STORAGE_OBJECT_CHANGED");
  if (object.state !== "verified") {
    const remote = await target.store.read(
      object.objectKey,
      undefined,
      object.versionId ?? undefined,
      context.signal,
    );
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of remote.body) {
      bytes += chunk.length;
      if (bytes > object.bytes) {
        remote.body.destroy();
        throw storageFailure("STORAGE_OBJECT_CHANGED");
      }
      hash.update(chunk);
    }
    if (bytes !== object.bytes || hash.digest("hex") !== object.sha256)
      throw storageFailure("STORAGE_OBJECT_CHANGED");
  } else if (object.etag !== facts.etag) throw storageFailure("STORAGE_OBJECT_CHANGED");
  context.assertActive();
  return context.database.db
    .update(storageObjects)
    .set({
      state: "verified",
      etag: facts.etag,
      versionId: facts.versionId ?? object.versionId,
      verifiedAt: context.config.now(),
    })
    .where(eq(storageObjects.id, object.id))
    .returning()
    .get();
};

const writePart = async (
  context: TransferContext,
  target: StorageTarget,
  key: string,
  uploadId: string,
  partNumber: number,
  source: TransferSource,
  start: number,
  end: number,
) => {
  if ("target" in source && source.target.id === target.id)
    return target.store.copyPart(
      key,
      uploadId,
      partNumber,
      {
        bucket: source.target.store.bucket,
        key: source.object.objectKey,
        start,
        end,
        ...(source.object.versionId === null ? {} : { versionId: source.object.versionId }),
      },
      context.signal,
    );
  const body =
    "path" in source
      ? await localSourcePart(context, source, start, end)
      : (
          await source.target.store.read(
            source.object.objectKey,
            `bytes=${start}-${end}`,
            source.object.versionId ?? undefined,
            context.signal,
          )
        ).body;
  return target.store
    .uploadPart(key, uploadId, partNumber, body, end - start + 1, context.signal)
    .finally(() => body.destroy());
};
const localSourcePart = async (
  context: TransferContext,
  source: Extract<TransferSource, { path: string }>,
  start: number,
  end: number,
) => {
  if (source.expiresAt <= context.config.now()) throw storageFailure("STORAGE_RECOVERY_EXPIRED");
  const [root, path] = await Promise.all([
    realpath(context.config.mediaRoot),
    realpath(source.path),
  ]);
  const child = relative(resolve(root), path);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
    throw storageFailure("STORAGE_RECOVERY_EXPIRED");
  return createReadStream(path, {
    start,
    end,
    signal: AbortSignal.any([
      context.signal,
      AbortSignal.timeout(Math.max(1, source.expiresAt - context.config.now())),
    ]),
  });
};
