import { randomUUID } from "node:crypto";
import { transitionVideo } from "./video-lifecycle.ts";
import type { StorageVisibility } from "@densio/shared";
import { and, eq, ne } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../database/database.ts";
import {
  storageTransfers,
  videoAccessGrants,
  videoVariants,
  videos,
} from "../database/video-storage-schema.ts";
import { canonicalDigest } from "../idempotency/canonical-digest.ts";
import {
  authorizeOrganization,
  type OrganizationActor,
} from "../organizations/organization-access.ts";
import { storageFailure } from "../storage/storage-errors.ts";
import { readVideo } from "./video-catalog.ts";
import type { VideoServiceConfig } from "./video-config.ts";

export type OwnedVideoInput = OrganizationActor & { readonly videoId: string };
export const renameVideo = (
  database: Database,
  input: OwnedVideoInput & { readonly name: string },
) =>
  database.db.transaction((transaction) => {
    authorizeOrganization(transaction, input, "media-write");
    const video = readVideo(database, input.organizationId, input.videoId);
    if (video.state === "deleted" || video.state === "deleting")
      throw storageFailure("STORAGE_INVALID_STATE");
    transaction
      .update(videos)
      .set({ displayName: input.name })
      .where(and(eq(videos.id, input.videoId), eq(videos.organizationId, input.organizationId)))
      .run();
    return {
      organizationId: input.organizationId,
      video: readVideo(database, input.organizationId, input.videoId),
    };
  });

export const mutateVideo = (
  database: Database,
  config: VideoServiceConfig,
  input: OwnedVideoInput & {
    readonly idempotencyKey: string;
    readonly visibility?: StorageVisibility;
    readonly deleteObjects?: boolean;
  },
) =>
  database.db.transaction(
    (transaction) => {
      authorizeOrganization(transaction, input, "media-write");
      const kind = input.visibility === undefined ? "delete" : "visibility";
      const digest = canonicalDigest({
        kind,
        videoId: input.videoId,
        visibility: input.visibility,
        deleteObjects: input.deleteObjects ?? false,
      });
      const existing = transaction
        .select()
        .from(storageTransfers)
        .where(
          and(
            eq(storageTransfers.organizationId, input.organizationId),
            eq(storageTransfers.idempotencyKey, input.idempotencyKey),
          ),
        )
        .get();
      if (existing) {
        if (existing.requestDigest !== digest) throw storageFailure("IDEMPOTENCY_CONFLICT");
        return {
          organizationId: input.organizationId,
          replayed: true,
          video: readVideo(database, input.organizationId, input.videoId),
        };
      }
      const video = transaction
        .select()
        .from(videos)
        .where(and(eq(videos.id, input.videoId), eq(videos.organizationId, input.organizationId)))
        .get();
      if (!video) throw storageFailure("VIDEO_NOT_FOUND");
      validateVideoMutation(video, kind, input.deleteObjects);
      const now = config.now();
      const id = randomUUID();
      const revision = video.visibilityRevision + 1;
      recordVideoMutation(transaction, video, { id, revision, now, kind, digest, input });
      return {
        organizationId: input.organizationId,
        replayed: false,
        video: readVideo(database, input.organizationId, input.videoId),
      };
    },
    { behavior: "immediate" },
  );

const validateVideoMutation = (
  video: typeof videos.$inferSelect,
  kind: "delete" | "visibility",
  deleteObjects: boolean | undefined,
) => {
  if (["deleted", "deleting", "visibility-changing"].includes(video.state))
    throw storageFailure("STORAGE_INVALID_STATE");
  if (kind === "visibility" && (video.connectionId !== null || video.state !== "ready"))
    throw storageFailure("STORAGE_VISIBILITY_UNSUPPORTED");
  if (kind === "delete" && video.connectionId !== null && deleteObjects !== true)
    throw storageFailure(
      "INVALID_REQUEST",
      "Customer objects require explicit deleteObjects: true; use forget to retain them.",
    );
};
const recordVideoMutation = (
  transaction: DatabaseTransaction,
  video: typeof videos.$inferSelect,
  request: {
    id: string;
    revision: number;
    now: number;
    kind: "delete" | "visibility";
    digest: string;
    input: OwnedVideoInput & {
      idempotencyKey: string;
      visibility?: StorageVisibility;
      deleteObjects?: boolean;
    };
  },
) => {
  const { id, revision, now, kind, digest, input } = request;
  const unchanged = kind === "visibility" && video.visibility === input.visibility;
  if (unchanged) {
    transaction
      .insert(storageTransfers)
      .values({
        id,
        organizationId: input.organizationId,
        videoId: video.id,
        kind,
        state: "succeeded",
        revision: video.visibilityRevision,
        nextAttemptAt: now,
        recoveryDeadline: now,
        intentJson: JSON.stringify({ visibility: input.visibility }),
        idempotencyKey: input.idempotencyKey,
        requestDigest: digest,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return;
  }
  transaction
    .update(storageTransfers)
    .set({ state: "canceled", revision, updatedAt: now })
    .where(and(eq(storageTransfers.videoId, video.id), ne(storageTransfers.state, "succeeded")))
    .run();
  transaction
    .insert(storageTransfers)
    .values({
      id,
      organizationId: input.organizationId,
      videoId: video.id,
      kind,
      state: "pending",
      revision,
      nextAttemptAt: now,
      recoveryDeadline: now + 86_400_000,
      intentJson: JSON.stringify({
        visibility: input.visibility,
        deleteObjects: input.deleteObjects ?? false,
      }),
      idempotencyKey: input.idempotencyKey,
      requestDigest: digest,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  transitionVideo(transaction, video, {
    state: kind === "delete" ? "deleting" : "visibility-changing",
    visibilityRevision: revision,
    transferId: id,
    errorCode: null,
  });
  const variants = transaction
    .select()
    .from(videoVariants)
    .where(eq(videoVariants.videoId, video.id))
    .all();
  variants.forEach((variant) =>
    transaction.delete(videoAccessGrants).where(eq(videoAccessGrants.variantId, variant.id)).run(),
  );
};
