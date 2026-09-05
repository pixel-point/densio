import { and, eq, inArray, lte } from "drizzle-orm";
import type { Database } from "../../database/database.ts";
import { storageTransfers, videos } from "../../database/video-storage-schema.ts";
import { queueStorageDeletion } from "../managed/storage-retention.ts";

export const retireExpiredTransfers = (database: Database, now: number) =>
  database.db.transaction(
    (transaction) => {
      const expired = transaction
        .select()
        .from(storageTransfers)
        .where(
          and(
            inArray(storageTransfers.kind, ["save", "export"]),
            inArray(storageTransfers.state, [
              "pending",
              "uploading",
              "verifying",
              "retry-wait",
              "blocked",
              "failed",
            ]),
            lte(storageTransfers.recoveryDeadline, now),
          ),
        )
        .limit(100)
        .all();
      expired.forEach((transfer) => {
        const video = transaction
          .select()
          .from(videos)
          .where(eq(videos.id, transfer.videoId))
          .get();
        if (!video || video.transferId !== transfer.id || video.state === "ready") return;
        queueStorageDeletion(transaction, video, now, { cleanup: true });
      });
    },
    { behavior: "immediate" },
  );
