import { replayVideoReceipt } from "./video-receipts.ts";
import { transitionVideo } from "./video-lifecycle.ts";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../database/database.ts";
import {
  storageRequests,
  storageTransfers,
  videoAccessGrants,
  videoVariants,
  videos,
} from "../database/video-storage-schema.ts";
import { canonicalDigest } from "../idempotency/canonical-digest.ts";
import { authorizeOrganization } from "../organizations/organization-access.ts";
import { storageFailure } from "../storage/storage-errors.ts";
import { readVideo } from "./video-catalog.ts";
import type { VideoServiceConfig } from "./video-config.ts";
import type { OwnedVideoInput } from "./video-mutations.ts";

export const recoverVideo = (
  database: Database,
  config: VideoServiceConfig,
  input: OwnedVideoInput & {
    readonly action: "retry" | "cancel" | "forget";
    readonly idempotencyKey: string;
  },
) =>
  database.db.transaction(
    (transaction) => {
      authorizeOrganization(transaction, input, "media-write");
      const digest = canonicalDigest({ action: input.action, videoId: input.videoId });
      const previous = transaction
        .select()
        .from(storageRequests)
        .where(
          and(
            eq(storageRequests.organizationId, input.organizationId),
            eq(storageRequests.idempotencyKey, input.idempotencyKey),
          ),
        )
        .get();
      const replay = replayVideoReceipt(database, input.organizationId, digest, previous);
      if (replay) return replay;
      const video = transaction
        .select()
        .from(videos)
        .where(and(eq(videos.id, input.videoId), eq(videos.organizationId, input.organizationId)))
        .get();
      if (!video) throw storageFailure("VIDEO_NOT_FOUND");
      const transfer = transaction
        .select()
        .from(storageTransfers)
        .where(eq(storageTransfers.id, video.transferId))
        .get();
      if (!transfer) throw storageFailure("STORAGE_TRANSFER_NOT_FOUND");
      if (input.action === "retry") retryStoredVideo(transaction, video, transfer, config);
      if (input.action === "cancel")
        cancelStoredVideo(transaction, video, transfer, config, input, digest);
      if (input.action === "forget") {
        if (
          video.connectionId === null ||
          !["ready", "unavailable", "storage-failed", "storage-blocked"].includes(video.state) ||
          transfer.workerPid !== null
        )
          throw storageFailure("STORAGE_INVALID_STATE");
        transitionVideo(transaction, video, {
          state: "deleted",
          deletedAt: config.now(),
          errorCode: null,
        });
        transaction
          .update(storageTransfers)
          .set({ state: "canceled", revision: transfer.revision + 1, updatedAt: config.now() })
          .where(eq(storageTransfers.id, transfer.id))
          .run();
        transaction
          .select()
          .from(videoVariants)
          .where(eq(videoVariants.videoId, video.id))
          .all()
          .forEach((variant) =>
            transaction
              .delete(videoAccessGrants)
              .where(eq(videoAccessGrants.variantId, variant.id))
              .run(),
          );
      }
      transaction
        .insert(storageRequests)
        .values({
          id: randomUUID(),
          organizationId: input.organizationId,
          videoId: video.id,
          idempotencyKey: input.idempotencyKey,
          requestDigest: digest,
          createdAt: config.now(),
        })
        .run();
      return {
        organizationId: input.organizationId,
        replayed: false,
        video: readVideo(database, input.organizationId, video.id),
      };
    },
    { behavior: "immediate" },
  );

const retryStoredVideo = (
  transaction: DatabaseTransaction,
  video: typeof videos.$inferSelect,
  transfer: typeof storageTransfers.$inferSelect,
  config: VideoServiceConfig,
) => {
  if (!["blocked", "failed", "retry-wait"].includes(transfer.state))
    throw storageFailure("STORAGE_INVALID_STATE");
  if (transfer.recoveryDeadline <= config.now() && ["save", "export"].includes(transfer.kind))
    throw storageFailure("STORAGE_RECOVERY_EXPIRED");
  transaction
    .update(storageTransfers)
    .set({
      state: "pending",
      errorCode: null,
      nextAttemptAt: config.now(),
      updatedAt: config.now(),
    })
    .where(eq(storageTransfers.id, transfer.id))
    .run();
  transitionVideo(transaction, video, {
    state:
      transfer.kind === "delete"
        ? "deleting"
        : transfer.kind === "visibility"
          ? "visibility-changing"
          : "storing",
    errorCode: null,
  });
};

const cancelStoredVideo = (
  transaction: DatabaseTransaction,
  video: typeof videos.$inferSelect,
  transfer: typeof storageTransfers.$inferSelect,
  config: VideoServiceConfig,
  input: { idempotencyKey: string; organizationId: string },
  digest: string,
) => {
  if (!["storing", "storage-blocked", "storage-failed"].includes(video.state))
    throw storageFailure("STORAGE_INVALID_STATE");
  const deletionId = randomUUID();
  transaction
    .update(storageTransfers)
    .set({ state: "canceled", revision: transfer.revision + 1, updatedAt: config.now() })
    .where(eq(storageTransfers.id, transfer.id))
    .run();
  transaction
    .insert(storageTransfers)
    .values({
      id: deletionId,
      organizationId: input.organizationId,
      videoId: video.id,
      kind: "delete",
      state: "pending",
      revision: video.visibilityRevision + 1,
      nextAttemptAt: config.now(),
      recoveryDeadline: config.now() + 86_400_000,
      intentJson: '{"deleteObjects":true}',
      idempotencyKey: `cancel:${input.idempotencyKey}`,
      requestDigest: digest,
      createdAt: config.now(),
      updatedAt: config.now(),
    })
    .run();
  transitionVideo(transaction, video, {
    state: "deleting",
    transferId: deletionId,
    visibilityRevision: video.visibilityRevision + 1,
    errorCode: null,
  });
};
