import {
  activateStorageFile,
  fileObjectPredicate,
  privateFileKey,
  videoStorageFiles,
  type StorageFile,
} from "./storage-files.ts";
import { transitionVideo } from "../../videos/video-lifecycle.ts";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { storageObjects, storageTransfers, videos } from "../../database/video-storage-schema.ts";
import { storageUsage } from "../../videos/storage-policy.ts";
import { storageFailure } from "../storage-errors.ts";
import { requireActiveConnection } from "../connections/connection-catalog.ts";
import { prepareObject, transferObject, type TransferSource } from "./object-transfer.ts";
import type { TransferContext } from "./transfer-context.ts";
import {
  verifyTransferredPublicFiles,
  type TransferredStorageFile,
} from "./public-file-delivery.ts";

export const deliverStoredVideo = async (context: TransferContext) => {
  const video = reserveVideoCapacity(context);
  const variants = videoStorageFiles(context.database.db, video.id);
  const destination = await context.config.resolveTarget(video.targetId, video.visibility);
  const staged = await stageManagedVariants(context, video, variants);
  const transferred: TransferredStorageFile[] = [];
  for (const variant of variants) {
    reserveVideoCapacity(context);
    const existing = context.database.db
      .select()
      .from(storageObjects)
      .where(
        and(
          eq(storageObjects.transferId, context.transfer.id),
          fileObjectPredicate(variant),
          eq(storageObjects.bucketRole, video.visibility),
        ),
      )
      .get();
    const key =
      existing?.objectKey ??
      (video.visibility === "public" || video.connectionId !== null
        ? variant.publicKey
        : privateFileKey(variant));
    const object = prepareObject(context, destination, variant, key);
    const verified = await transferObject(
      context,
      destination,
      object,
      variant,
      staged.get(variant.id) ??
        (variant.activeObjectId
          ? { path: "", expiresAt: 0 }
          : await variantInput(context, variant)),
    );
    transferred.push({ file: variant, objectId: verified.id });
  }
  if (video.visibility === "public")
    await verifyTransferredPublicFiles(context, video, transferred);
  context.assertActive();
  transferred.forEach(({ file, objectId }) =>
    activateStorageFile(context.database.db, file, objectId),
  );
  await cleanTransferStaging(context);
  reserveVideoCapacity(context);
  context.assertActive();
  context.database.db.transaction((transaction) => {
    transitionVideo(transaction, video, {
      state: "ready",
      storedAt: context.config.now(),
      errorCode: null,
      capacityState: video.connectionId === null ? "used" : "none",
    });
    transaction
      .update(storageTransfers)
      .set({ state: "succeeded", errorCode: null, updatedAt: context.config.now() })
      .where(eq(storageTransfers.id, context.transfer.id))
      .run();
  });
};

const localInput = (variant: StorageFile): TransferSource => {
  if (variant.inputPath === null) throw storageFailure("STORAGE_RECOVERY_EXPIRED");
  return { path: variant.inputPath, expiresAt: variant.inputExpiresAt };
};
const reserveVideoCapacity = (context: TransferContext) =>
  context.database.db.transaction(
    (transaction) => {
      context.assertActive();
      const video = transaction
        .select()
        .from(videos)
        .where(eq(videos.id, context.transfer.videoId))
        .get();
      if (!video) throw storageFailure("VIDEO_NOT_FOUND");
      if (video.connectionId !== null) {
        requireActiveConnection(context.database, video.organizationId, video.connectionId);
        return video;
      }
      const usage = storageUsage(context.database, context.config, video.organizationId);
      if (usage.includedStorageBytes === 0) throw storageFailure("STORAGE_UPGRADE_REQUIRED");
      if (
        usage.usedBytes +
          usage.reservedBytes +
          (video.capacityState === "none" ? video.totalBytes : 0) >
        usage.includedStorageBytes
      )
        throw storageFailure("STORAGE_QUOTA_EXCEEDED");
      if (video.capacityState === "none")
        transaction
          .update(videos)
          .set({ capacityState: "reserved" })
          .where(eq(videos.id, video.id))
          .run();
      return video;
    },
    { behavior: "immediate" },
  );

export const cleanTransferStaging = async (context: TransferContext) => {
  const objects = context.database.db
    .select()
    .from(storageObjects)
    .where(
      and(
        eq(storageObjects.transferId, context.transfer.id),
        eq(storageObjects.bucketRole, "staging"),
      ),
    )
    .all();
  for (const object of objects) {
    if (object.state === "deleted") continue;
    const target = await context.config.resolveTarget(object.targetId, "staging");
    await target.store.remove(object.objectKey, object.versionId ?? undefined, context.signal);
    if (
      (await target.store.head(object.objectKey, object.versionId ?? undefined, context.signal)) !==
      null
    )
      throw storageFailure("STORAGE_DELETION_BLOCKED");
    context.database.db
      .update(storageObjects)
      .set({ state: "deleted", deletedAt: context.config.now() })
      .where(eq(storageObjects.id, object.id))
      .run();
  }
};

const variantInput = async (
  context: TransferContext,
  variant: StorageFile,
): Promise<TransferSource> => {
  if (!variant.inputObjectId) return localInput(variant);
  const object = context.database.db
    .select()
    .from(storageObjects)
    .where(
      and(
        eq(storageObjects.id, variant.inputObjectId),
        eq(storageObjects.organizationId, variant.organizationId),
      ),
    )
    .get();
  if (object?.state !== "verified") throw storageFailure("STORAGE_OBJECT_CHANGED");
  if (object.connectionId !== null)
    requireActiveConnection(context.database, object.organizationId, object.connectionId);
  return { object, target: await context.config.resolveTarget(object.targetId, object.bucketRole) };
};

const stageManagedVariants = async (
  context: TransferContext,
  video: typeof videos.$inferSelect,
  variants: readonly StorageFile[],
) => {
  const staged = new Map<string, TransferSource>();
  if (video.connectionId === null && variants.some((variant) => variant.activeObjectId === null)) {
    const staging = await context.config.resolveTarget(video.targetId, "staging");
    for (const variant of variants) {
      const existing = context.database.db
        .select()
        .from(storageObjects)
        .where(
          and(
            eq(storageObjects.transferId, context.transfer.id),
            fileObjectPredicate(variant),
            eq(storageObjects.bucketRole, "staging"),
          ),
        )
        .get();
      const key =
        existing?.objectKey ??
        `orgs/${video.organizationId}/transfers/${context.transfer.id}/attempts/${randomUUID()}/${variant.id}/${variant.filename}`;
      const object = prepareObject(context, staging, variant, key);
      const verified = await transferObject(context, staging, object, variant, localInput(variant));
      staged.set(variant.id, { target: staging, object: verified });
    }
  }
  return staged;
};
