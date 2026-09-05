import { findJobHlsPackage, recordHlsMembers } from "./hls-video-intent.ts";
import { randomUUID } from "node:crypto";
import { and, inArray, lt } from "drizzle-orm";
import { MediaCodecSchema, type StoredVideoPlan } from "@densio/shared";
import { Schema } from "effect";
import type { DatabaseTransaction } from "../database/database.ts";
import { artifacts } from "../database/schema.ts";
import { storageTransfers, videos, videoVariants } from "../database/video-storage-schema.ts";
import { managedObjectKey } from "../storage/managed/object-key.ts";
import { storageFailure } from "../storage/storage-errors.ts";

export const recordVideoIntent = (
  transaction: DatabaseTransaction,
  input: {
    readonly organizationId: string;
    readonly jobId: string;
    readonly storage: StoredVideoPlan;
    readonly artifacts: readonly (typeof artifacts.$inferSelect)[];
    readonly automatic: boolean;
    readonly idempotencyKey: string;
    readonly requestDigest: string;
    readonly now: number;
  },
) => {
  if (
    input.artifacts.length !== input.storage.files.length ||
    input.storage.files.some(
      (file) => !input.artifacts.some((artifact) => artifact.codec === file.codec),
    )
  )
    throw storageFailure(
      "STORAGE_OBJECT_CHANGED",
      "The complete requested variant set is required.",
    );
  const hlsPackage = findJobHlsPackage(transaction, input.jobId);
  const id = randomUUID();
  const transferId = randomUUID();
  const storage = input.storage;
  const recoveryDeadline = input.now + 86_400_000;
  transaction
    .update(artifacts)
    .set({ retainedUntil: recoveryDeadline })
    .where(
      and(
        inArray(
          artifacts.id,
          input.artifacts.map(({ id: artifactId }) => artifactId),
        ),
        lt(artifacts.retainedUntil, recoveryDeadline),
      ),
    )
    .run();
  transaction
    .insert(videos)
    .values({
      id,
      hlsPackageId: hlsPackage?.row.id ?? null,
      organizationId: input.organizationId,
      jobId: input.jobId,
      automaticJobId: input.automatic ? input.jobId : null,
      displayName: storage.displayName,
      filenameStem: storage.filenameStem,
      destinationJson: JSON.stringify(storage.destination),
      targetId: storage.targetId,
      connectionId:
        storage.destination.kind === "connection" ? storage.destination.connectionId : null,
      publicOrigin: storage.publicOrigin ?? null,
      visibility: storage.visibility,
      state: "storing",
      transferId,
      totalBytes:
        hlsPackage?.contents.packageBytes ??
        input.artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0),
      createdAt: input.now,
      idempotencyKey: input.idempotencyKey,
      requestDigest: input.requestDigest,
    })
    .run();
  if (hlsPackage)
    recordHlsMembers(transaction, { package: hlsPackage, videoId: id, storage, recoveryDeadline });
  if (!hlsPackage)
    transaction
      .insert(videoVariants)
      .values(
        input.artifacts.map((artifact) =>
          variantIntent(artifact, input.organizationId, id, storage, recoveryDeadline),
        ),
      )
      .run();
  transaction
    .insert(storageTransfers)
    .values({
      id: transferId,
      organizationId: input.organizationId,
      videoId: id,
      kind: "save",
      state: "pending",
      nextAttemptAt: input.now,
      recoveryDeadline,
      intentJson: JSON.stringify({
        destination: storage.destination,
        visibility: storage.visibility,
      }),
      idempotencyKey: `save:${input.idempotencyKey}`,
      requestDigest: input.requestDigest,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .run();
  return { videoId: id, transferId };
};

const variantIntent = (
  artifact: typeof artifacts.$inferSelect,
  organizationId: string,
  id: string,
  storage: StoredVideoPlan,
  recoveryDeadline: number,
) => {
  const codec = Schema.decodeUnknownSync(MediaCodecSchema)(artifact.codec);
  const filename = storage.files.find((file) => file.codec === codec)?.filename;
  if (!filename) throw storageFailure("STORAGE_OBJECT_CHANGED");
  return {
    id: randomUUID(),
    organizationId: organizationId,
    videoId: id,
    artifactId: artifact.id,
    filename,
    codec,
    mediaType: codec === "h265" ? ("video/mp4" as const) : ("video/webm" as const),
    bytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    width: artifact.width,
    height: artifact.height,
    durationSeconds: artifact.durationSeconds,
    inputPath: artifact.path,
    inputExpiresAt: recoveryDeadline,
    publicKey:
      storage.destination.kind === "managed"
        ? managedObjectKey(organizationId, id, filename)
        : `${storage.keyPrefix}/${id}/${filename}`,
  };
};
