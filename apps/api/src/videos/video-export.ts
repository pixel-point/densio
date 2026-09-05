import { replayVideoCreation } from "./video-receipts.ts";
import { randomUUID } from "node:crypto";
import type { StorageVisibility } from "@densio/shared";
import { and, eq } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../database/database.ts";
import {
  storageTransfers,
  videoVariants,
  videoPackageMembers,
  videos,
} from "../database/video-storage-schema.ts";
import { canonicalDigest } from "../idempotency/canonical-digest.ts";
import { authorizeOrganization } from "../organizations/organization-access.ts";
import { storageFailure } from "../storage/storage-errors.ts";
import { requireActiveConnection } from "../storage/connections/connection-catalog.ts";
import { readVideo } from "./video-catalog.ts";
import type { VideoServiceConfig } from "./video-config.ts";
import type { OwnedVideoInput } from "./video-mutations.ts";
import { validateDestination } from "./storage-policy.ts";

export const exportVideo = (
  database: Database,
  config: VideoServiceConfig,
  input: OwnedVideoInput & {
    readonly connectionId: string;
    readonly visibility?: StorageVisibility;
    readonly idempotencyKey: string;
  },
) =>
  database.db.transaction(
    (transaction) => {
      authorizeOrganization(transaction, input, "media-write");
      const digest = canonicalDigest({
        action: "export",
        videoId: input.videoId,
        connectionId: input.connectionId,
        visibility: input.visibility ?? "public",
      });
      const previous = replayVideoCreation(
        database,
        transaction,
        input.organizationId,
        input.idempotencyKey,
        digest,
      );
      if (previous) return previous;
      const source = transaction
        .select()
        .from(videos)
        .where(and(eq(videos.id, input.videoId), eq(videos.organizationId, input.organizationId)))
        .get();
      if (!source) throw storageFailure("VIDEO_NOT_FOUND");
      if (source.state !== "ready") throw storageFailure("STORAGE_INVALID_STATE");
      if (source.connectionId !== null)
        requireActiveConnection(database, source.organizationId, source.connectionId);
      const visibility = input.visibility ?? "public";
      const destination = { kind: "connection" as const, connectionId: input.connectionId };
      const target = validateDestination(
        database,
        config,
        input.organizationId,
        destination,
        visibility,
      );
      const id = randomUUID();
      const transferId = randomUUID();
      const now = config.now();
      transaction
        .insert(videos)
        .values({
          id,
          organizationId: input.organizationId,
          jobId: source.jobId,
          hlsPackageId: source.hlsPackageId,
          displayName: source.displayName,
          filenameStem: source.filenameStem,
          destinationJson: JSON.stringify(destination),
          targetId: target.targetId,
          connectionId: input.connectionId,
          publicOrigin: target.publicOrigin,
          visibility,
          state: "storing",
          transferId,
          totalBytes: source.totalBytes,
          createdAt: now,
          idempotencyKey: input.idempotencyKey,
          requestDigest: digest,
        })
        .run();
      copyVariantIntent(transaction, source.id, id, target.prefix, now);
      transaction
        .insert(storageTransfers)
        .values({
          id: transferId,
          organizationId: input.organizationId,
          videoId: id,
          kind: "export",
          state: "pending",
          nextAttemptAt: now,
          recoveryDeadline: now + 86_400_000,
          intentJson: JSON.stringify({ sourceVideoId: source.id }),
          idempotencyKey: `export:${input.idempotencyKey}`,
          requestDigest: digest,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return {
        organizationId: input.organizationId,
        replayed: false,
        video: readVideo(database, input.organizationId, id),
      };
    },
    { behavior: "immediate" },
  );

const copyVariantIntent = (
  transaction: DatabaseTransaction,
  sourceId: string,
  id: string,
  prefix: string,
  now: number,
) => {
  [videoVariants, videoPackageMembers].forEach((table) => {
    const variants = transaction.select().from(table).where(eq(table.videoId, sourceId)).all();
    if (!variants.length) return;
    transaction
      .insert(table)
      .values(
        variants.map((variant) => {
          if (!variant.activeObjectId) throw storageFailure("STORAGE_OBJECT_CHANGED");
          return {
            ...variant,
            id: randomUUID(),
            videoId: id,
            artifactId: null,
            inputPath: null,
            inputObjectId: variant.activeObjectId,
            inputExpiresAt: now + 86_400_000,
            activeObjectId: null,
            publicKey: `${prefix}/${id}/${variant.filename}`,
          };
        }),
      )
      .run();
  });
};
