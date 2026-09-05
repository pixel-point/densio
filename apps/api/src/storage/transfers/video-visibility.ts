import {
  activateStorageFile,
  fileObjectPredicate,
  privateFileKey,
  videoStorageFiles,
  type StorageFile,
} from "./storage-files.ts";
import { transitionVideo } from "../../videos/video-lifecycle.ts";
import { rebindObjectInputs } from "./object-consumers.ts";
import { beginRetentionDeletion } from "../managed/retention-deletion-guard.ts";
import { StorageVisibilitySchema } from "@densio/shared";
import { and, eq, ne } from "drizzle-orm";
import { Schema } from "effect";
import { storageObjects, storageTransfers, videos } from "../../database/video-storage-schema.ts";
import { publicObjectUrl } from "../../videos/video-catalog.ts";
import { storageFailure } from "../storage-errors.ts";
import { prepareObject, transferObject } from "./object-transfer.ts";
import { removeStoredObject } from "./object-deletion.ts";
import type { TransferContext } from "./transfer-context.ts";

const VisibilityIntent = Schema.Struct({ visibility: StorageVisibilitySchema });
export const changeStoredVisibility = async (context: TransferContext) => {
  const intent = Schema.decodeUnknownSync(Schema.fromJsonString(VisibilityIntent))(
    context.transfer.intentJson,
  );
  const video = context.database.db
    .select()
    .from(videos)
    .where(eq(videos.id, context.transfer.videoId))
    .get();
  if (!video) throw storageFailure("VIDEO_NOT_FOUND");
  const target = await context.config.resolveTarget(video.targetId, intent.visibility);
  const variants = videoStorageFiles(context.database.db, video.id);
  const replacements: { file: StorageFile; objectId: string }[] = [];
  for (const variant of variants) {
    const source = context.database.db
      .select()
      .from(storageObjects)
      .where(eq(storageObjects.id, variant.activeObjectId ?? ""))
      .get();
    if (!source) throw storageFailure("STORAGE_OBJECT_CHANGED");
    const sourceTarget = await context.config.resolveTarget(source.targetId, source.bucketRole);
    const existing = context.database.db
      .select()
      .from(storageObjects)
      .where(
        and(
          fileObjectPredicate(variant),
          eq(storageObjects.bucketRole, intent.visibility),
          ne(storageObjects.state, "deleted"),
        ),
      )
      .get();
    const key =
      intent.visibility === "public"
        ? variant.publicKey
        : (existing?.objectKey ?? privateFileKey(variant));
    restoreCanonicalObject(context, target, key, variant);
    const object = prepareObject(context, target, variant, key);
    const verified = await transferObject(context, target, object, variant, {
      target: sourceTarget,
      object: source,
    });
    if (intent.visibility === "public") {
      const url = publicObjectUrl(video.publicOrigin ?? "", key);
      await context.config.verifyPublic(
        url,
        variant.bytes,
        variant.mediaType,
        context.signal,
        variant.kind === "hls",
      );
      context.database.db
        .update(storageObjects)
        .set({ publicUrl: url })
        .where(eq(storageObjects.id, object.id))
        .run();
    }
    context.assertActive();
    rebindObjectInputs(context.database.db, source, verified);
    replacements.push({ file: variant, objectId: verified.id });
  }
  const obsolete = context.database.db
    .select()
    .from(storageObjects)
    .where(
      and(
        eq(storageObjects.videoId, video.id),
        ne(storageObjects.bucketRole, intent.visibility),
        ne(storageObjects.state, "deleted"),
      ),
    )
    .all();
  const removed = [];
  for (const object of obsolete) removed.push(await removeStoredObject(context, object));
  if (removed.includes(false)) {
    waitForWithdrawal(context);
    return;
  }
  context.assertActive();
  context.database.db.transaction((transaction) => {
    replacements.forEach((replacement) =>
      activateStorageFile(transaction, replacement.file, replacement.objectId),
    );
    transitionVideo(transaction, video, {
      visibility: intent.visibility,
      state: "ready",
      errorCode: null,
    });
    transaction
      .update(storageTransfers)
      .set({ state: "succeeded", errorCode: null })
      .where(eq(storageTransfers.id, context.transfer.id))
      .run();
  });
};

export const deleteStoredVideo = async (context: TransferContext) => {
  if (!beginRetentionDeletion(context)) return;
  const video = context.database.db
    .select()
    .from(videos)
    .where(eq(videos.id, context.transfer.videoId))
    .get();
  if (!video) throw storageFailure("VIDEO_NOT_FOUND");
  const cleanup = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ cleanup: Schema.optionalKey(Schema.Boolean) })),
  )(context.transfer.intentJson).cleanup;
  const objects = context.database.db
    .select()
    .from(storageObjects)
    .where(
      and(
        eq(storageObjects.videoId, context.transfer.videoId),
        ne(storageObjects.state, "deleted"),
      ),
    )
    .all();
  const removed = [];
  for (const object of objects) removed.push(await removeStoredObject(context, object));
  if (removed.includes(false)) {
    waitForWithdrawal(context);
    return;
  }
  context.assertActive();
  context.database.db.transaction((transaction) => {
    transitionVideo(transaction, video, {
      state: cleanup ? "storage-failed" : "deleted",
      capacityState: "none",
      deletedAt: context.config.now(),
      errorCode: cleanup ? "STORAGE_RECOVERY_EXPIRED" : null,
    });
    transaction
      .update(storageTransfers)
      .set({ state: "succeeded", errorCode: null })
      .where(eq(storageTransfers.id, context.transfer.id))
      .run();
  });
};
const waitForWithdrawal = (context: TransferContext) => {
  context.database.db
    .update(storageTransfers)
    .set({ state: "retry-wait", nextAttemptAt: context.config.now() + 1000 })
    .where(eq(storageTransfers.id, context.transfer.id))
    .run();
};

const restoreCanonicalObject = (
  context: TransferContext,
  target: Awaited<ReturnType<TransferContext["config"]["resolveTarget"]>>,
  key: string,
  variant: StorageFile,
) => {
  const retired = context.database.db
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
  if (retired?.state === "deleted") {
    context.assertActive();
    if (
      retired.sha256 !== variant.sha256 ||
      retired.bytes !== variant.bytes ||
      (retired.purgeAfter ?? 0) > context.config.now()
    )
      throw storageFailure("STORAGE_BUSY");
    context.database.db
      .update(storageObjects)
      .set({
        state: "planned",
        transferId: context.transfer.id,
        revision: context.transfer.revision,
        uploadId: null,
        partsJson: "[]",
        etag: null,
        versionId: null,
        purgedAt: null,
        purgeAfter: null,
        deletedAt: null,
        verifiedAt: null,
      })
      .where(eq(storageObjects.id, retired.id))
      .run();
  }
};
