import { and, eq } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../database/database.ts";
import { videos } from "../database/video-storage-schema.ts";
import { storageFailure } from "../storage/storage-errors.ts";
import { readVideo } from "./video-catalog.ts";

export const replayVideoCreation = (
  database: Database,
  transaction: DatabaseTransaction,
  organizationId: string,
  idempotencyKey: string,
  digest: string,
) =>
  replayVideoReceipt(
    database,
    organizationId,
    digest,
    transaction
      .select({ videoId: videos.id, requestDigest: videos.requestDigest })
      .from(videos)
      .where(
        and(eq(videos.organizationId, organizationId), eq(videos.idempotencyKey, idempotencyKey)),
      )
      .get(),
  );

export const replayVideoReceipt = (
  database: Database,
  organizationId: string,
  digest: string,
  receipt: { readonly videoId: string; readonly requestDigest: string } | undefined,
) => {
  if (!receipt) return undefined;
  if (receipt.requestDigest !== digest) throw storageFailure("IDEMPOTENCY_CONFLICT");
  return {
    organizationId,
    replayed: true,
    video: readVideo(database, organizationId, receipt.videoId),
  };
};
