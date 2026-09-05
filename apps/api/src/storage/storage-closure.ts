import { transitionVideo } from "../videos/video-lifecycle.ts";
import { randomUUID } from "node:crypto";
import { and, count, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import type { DatabaseTransaction } from "../database/database.ts";
import {
  sourceObjectUploads,
  storageConnectionOperations,
  storageConnections,
  storageTransfers,
  videoAccessGrants,
  hlsAccessGrants,
  videos,
} from "../database/video-storage-schema.ts";
import { queueStorageDeletion } from "./managed/storage-retention.ts";

export const closeOrganizationStorage = (
  transaction: DatabaseTransaction,
  organizationId: string,
  now: number,
) => {
  transaction
    .delete(videoAccessGrants)
    .where(eq(videoAccessGrants.organizationId, organizationId))
    .run();
  transaction
    .delete(hlsAccessGrants)
    .where(eq(hlsAccessGrants.organizationId, organizationId))
    .run();
  const owned = transaction
    .select()
    .from(videos)
    .where(and(eq(videos.organizationId, organizationId), ne(videos.state, "deleted")))
    .all();
  owned.forEach((video) => {
    if (video.connectionId === null) {
      queueStorageDeletion(transaction, video, now, { closure: true });
      return;
    }
    transaction
      .update(storageTransfers)
      .set({ state: "canceled", revision: video.visibilityRevision + 1, updatedAt: now })
      .where(and(eq(storageTransfers.videoId, video.id), ne(storageTransfers.state, "succeeded")))
      .run();
    transitionVideo(transaction, video, {
      state: "deleted",
      deletedAt: now,
      visibilityRevision: video.visibilityRevision + 1,
    });
  });
  transaction
    .update(sourceObjectUploads)
    .set({ state: "expired", nextAttemptAt: now })
    .where(
      and(
        eq(sourceObjectUploads.organizationId, organizationId),
        ne(sourceObjectUploads.state, "ready"),
      ),
    )
    .run();
  const connections = transaction
    .select()
    .from(storageConnections)
    .where(
      and(
        eq(storageConnections.organizationId, organizationId),
        ne(storageConnections.state, "disconnected"),
      ),
    )
    .all();
  connections.forEach((connection) => {
    transaction
      .update(storageConnections)
      .set({ state: "disabled", updatedAt: now })
      .where(eq(storageConnections.id, connection.id))
      .run();
    transaction
      .update(storageConnectionOperations)
      .set({ state: "blocked", errorCode: "ORGANIZATION_NOT_ACTIVE", updatedAt: now })
      .where(
        and(
          eq(storageConnectionOperations.connectionId, connection.id),
          inArray(storageConnectionOperations.state, ["pending", "running"]),
        ),
      )
      .run();
    transaction
      .insert(storageConnectionOperations)
      .values({
        id: randomUUID(),
        organizationId,
        connectionId: connection.id,
        kind: "disconnect",
        state: "pending",
        idempotencyKey: `closure:${connection.id}`,
        requestDigest: "closure",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
  });
};
export const storageClosurePending = (transaction: DatabaseTransaction, organizationId: string) =>
  [
    transaction
      .select({ count: count() })
      .from(videos)
      .where(
        and(
          eq(videos.organizationId, organizationId),
          isNull(videos.connectionId),
          ne(videos.state, "deleted"),
        ),
      )
      .get()?.count ?? 0,
    transaction
      .select({ count: count() })
      .from(storageConnections)
      .where(
        and(
          eq(storageConnections.organizationId, organizationId),
          ne(storageConnections.state, "disconnected"),
        ),
      )
      .get()?.count ?? 0,
    transaction
      .select({ count: count() })
      .from(storageConnectionOperations)
      .where(
        and(
          eq(storageConnectionOperations.organizationId, organizationId),
          isNotNull(storageConnectionOperations.candidateCiphertext),
        ),
      )
      .get()?.count ?? 0,
  ].some((value) => value > 0);
