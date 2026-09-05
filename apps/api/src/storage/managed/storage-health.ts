import { and, asc, eq, gt, lt, lte, or } from "drizzle-orm";
import { Effect } from "effect";
import type { Database } from "../../database/database.ts";
import {
  storageObjects,
  videos,
  videoVariants,
  videoPackageMembers,
} from "../../database/video-storage-schema.ts";
import { runMaintenancePages } from "../../services/maintenance-pages.ts";
import { transitionVideo } from "../../videos/video-lifecycle.ts";
import { storageEffect, storagePromise } from "../storage-errors.ts";
import type { StorageTarget } from "../objects/object-store.ts";

const verificationInterval = 86_400_000;
export const maintainStorageHealth = (
  database: Database,
  config: {
    readonly now: () => number;
    readonly resolveTarget: (id: string, role: StorageTarget["role"]) => Promise<StorageTarget>;
  },
) =>
  runMaintenancePages(
    ({ afterId, limit }) =>
      storageEffect("storage-health", () =>
        database.db
          .select({ id: storageObjects.id, object: storageObjects, video: videos })
          .from(storageObjects)
          .leftJoin(videoVariants, eq(videoVariants.activeObjectId, storageObjects.id))
          .leftJoin(videoPackageMembers, eq(videoPackageMembers.activeObjectId, storageObjects.id))
          .innerJoin(
            videos,
            or(eq(videos.id, videoVariants.videoId), eq(videos.id, videoPackageMembers.videoId)),
          )
          .where(
            and(
              eq(storageObjects.state, "verified"),
              eq(videos.state, "ready"),
              lt(storageObjects.verifiedAt, config.now() - verificationInterval),
              lte(storageObjects.healthCheckAfter, config.now()),
              afterId ? gt(storageObjects.id, afterId) : undefined,
            ),
          )
          .orderBy(asc(storageObjects.id))
          .limit(limit)
          .all(),
      ),
    ({ object, video }) =>
      storagePromise("storage-health", async (signal) => {
        const target = await config.resolveTarget(object.targetId, object.bucketRole);
        const facts = await target.store
          .head(object.objectKey, object.versionId ?? undefined, signal)
          .finally(() => target.store.close());
        database.db.transaction((transaction) => {
          const table = object.packageMemberId ? videoPackageMembers : videoVariants;
          const active = transaction
            .select()
            .from(table)
            .where(
              and(
                eq(table.id, object.packageMemberId ?? object.variantId ?? ""),
                eq(table.activeObjectId, object.id),
              ),
            )
            .get();
          if (!active) return;
          const unchanged = facts && facts.bytes === object.bytes && facts.etag === object.etag;
          const current = transitionVideo(transaction, video, {
            state: unchanged ? "ready" : "unavailable",
            errorCode: unchanged ? null : "STORAGE_OBJECT_CHANGED",
          });
          if (!current) return;
          transaction
            .update(storageObjects)
            .set({
              ...(unchanged ? { verifiedAt: config.now() } : {}),
              healthCheckAfter: config.now() + verificationInterval,
              healthErrorCode: unchanged ? null : "STORAGE_OBJECT_CHANGED",
            })
            .where(eq(storageObjects.id, object.id))
            .run();
        });
      }).pipe(
        Effect.tapError((error) =>
          storageEffect("storage-health", () => {
            database.db
              .update(storageObjects)
              .set({
                healthCheckAfter: config.now() + 60_000,
                healthErrorCode: error.code,
              })
              .where(eq(storageObjects.id, object.id))
              .run();
          }),
        ),
      ),
    "Storage health",
  ).pipe(Effect.asVoid);
