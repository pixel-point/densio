import { replayVideoCreation } from "./video-receipts.ts";
import { MediaCodecSchema, type VideoSaveRequest } from "@densio/shared";
import { Schema } from "effect";
import { and, eq } from "drizzle-orm";
import type { Database } from "../database/database.ts";
import { artifacts, jobs } from "../database/schema.ts";
import { canonicalDigest } from "../idempotency/canonical-digest.ts";
import {
  authorizeOrganization,
  type OrganizationActor,
} from "../organizations/organization-access.ts";
import { filenameStem, variantFilename } from "../storage/managed/object-key.ts";
import { storageFailure } from "../storage/storage-errors.ts";
import { storageDefaults, validateDestination } from "./storage-policy.ts";
import type { VideoServiceConfig } from "./video-config.ts";
import { recordVideoIntent } from "./video-intent.ts";
import { readVideo } from "./video-catalog.ts";

export type SaveVideoInput = OrganizationActor &
  VideoSaveRequest & { readonly idempotencyKey: string; readonly automatic?: boolean };

export const saveVideo = (database: Database, config: VideoServiceConfig, input: SaveVideoInput) =>
  database.db.transaction(
    (transaction) => {
      authorizeOrganization(transaction, input, "media-write");
      const digest = canonicalDigest({
        jobId: input.jobId,
        destination: input.destination,
        name: input.name,
        visibility: input.visibility,
      });
      const previous = replayVideoCreation(
        database,
        transaction,
        input.organizationId,
        input.idempotencyKey,
        digest,
      );
      if (previous) return previous;
      const defaults = storageDefaults(database, input.organizationId);
      const destination = input.destination ?? defaults.destination;
      if (destination.kind === "temporary")
        throw storageFailure("STORAGE_INVALID_STATE", "Select a stored destination before saving.");
      const job = transaction
        .select()
        .from(jobs)
        .where(and(eq(jobs.id, input.jobId), eq(jobs.organizationId, input.organizationId)))
        .get();
      if (job === undefined) throw storageFailure("VIDEO_NOT_FOUND");
      if (
        job.state !== "succeeded" ||
        (job.kind !== "compress" && job.kind !== "trim" && job.kind !== "hls")
      )
        throw storageFailure(
          "STORAGE_INVALID_STATE",
          "Only successful compression, trimming, or HLS jobs can be saved.",
        );
      const now = config.now();
      const sourceArtifacts = transaction
        .select()
        .from(artifacts)
        .where(
          and(
            eq(artifacts.jobId, job.id),
            eq(artifacts.organizationId, input.organizationId),
            eq(artifacts.kind, job.kind === "hls" ? "hls-archive" : "video"),
          ),
        )
        .all();
      if (
        sourceArtifacts.length === 0 ||
        sourceArtifacts.some(
          (artifact) =>
            artifact.codec === null || artifact.deletedAt !== null || artifact.retainedUntil <= now,
        )
      )
        throw storageFailure("STORAGE_RECOVERY_EXPIRED");
      const visibility = input.visibility ?? defaults.visibility;
      const location = validateDestination(
        database,
        config,
        input.organizationId,
        destination,
        visibility,
      );
      const stem = filenameStem(input.name, job.sourceFilename);
      const intent = recordVideoIntent(transaction, {
        organizationId: input.organizationId,
        jobId: job.id,
        storage: {
          destination,
          visibility,
          displayName: input.name ?? job.sourceFilename.replace(/\.[^.]*$/, ""),
          filenameStem: stem,
          targetId: location.targetId,
          keyPrefix: location.prefix,
          ...(location.publicOrigin ? { publicOrigin: location.publicOrigin } : {}),
          files: sourceArtifacts.map((artifact) => {
            const codec = Schema.decodeUnknownSync(MediaCodecSchema)(artifact.codec);
            return { codec, filename: variantFilename(stem, codec) };
          }),
        },
        artifacts: sourceArtifacts,
        automatic: input.automatic ?? false,
        now,
        idempotencyKey: input.idempotencyKey,
        requestDigest: digest,
      });
      return {
        organizationId: input.organizationId,
        replayed: false,
        video: readVideo(database, input.organizationId, intent.videoId),
      };
    },
    { behavior: "immediate" },
  );
