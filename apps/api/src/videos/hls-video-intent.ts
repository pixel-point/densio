import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { HlsPackageSchema, type StoredVideoPlan } from "@densio/shared";
import { eq } from "drizzle-orm";
import { Schema } from "effect";
import type { DatabaseTransaction } from "../database/database.ts";
import { hlsPackages } from "../database/schema.ts";
import { videoPackageMembers } from "../database/video-storage-schema.ts";
import { storageFailure } from "../storage/storage-errors.ts";

export const findJobHlsPackage = (transaction: DatabaseTransaction, jobId: string) => {
  const row = transaction.select().from(hlsPackages).where(eq(hlsPackages.jobId, jobId)).get();
  if (!row) return undefined;
  const contents = Schema.decodeUnknownSync(Schema.fromJsonString(HlsPackageSchema))(
    row.inventoryJson,
  );
  return { row, contents };
};

export const recordHlsMembers = (
  transaction: DatabaseTransaction,
  input: {
    readonly package: NonNullable<ReturnType<typeof findJobHlsPackage>>;
    readonly videoId: string;
    readonly storage: StoredVideoPlan;
    readonly recoveryDeadline: number;
  },
) => {
  const { row, contents } = input.package;
  if (contents.packageId !== row.id) throw storageFailure("STORAGE_OBJECT_CHANGED");
  const prefix =
    input.storage.destination.kind === "managed"
      ? `orgs/${row.organizationId}/videos/${input.videoId}`
      : `${input.storage.keyPrefix}/${input.videoId}`;
  transaction
    .insert(videoPackageMembers)
    .values(
      contents.members.map((member) => ({
        id: randomUUID(),
        organizationId: row.organizationId,
        videoId: input.videoId,
        artifactId: row.artifactId,
        filename: member.path,
        role: member.role,
        mediaType: member.mediaType,
        bytes: member.bytes,
        sha256: member.sha256,
        inputPath: join(row.directory, member.path),
        inputExpiresAt: input.recoveryDeadline,
        publicKey: `${prefix}/${member.path}`,
      })),
    )
    .run();
};
