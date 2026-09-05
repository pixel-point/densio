import { transitionVideo } from "../../videos/video-lifecycle.ts";
import { storagePurgeCandidates } from "./storage-purge-candidates.ts";
import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, ne } from "drizzle-orm";
import { Schema } from "effect";
import type { Database, DatabaseTransaction } from "../../database/database.ts";
import { emailOutbox, organizations } from "../../database/schema.ts";
import {
  storageSettings,
  storageTransfers,
  videoAccessGrants,
  videoVariants,
  videos,
} from "../../database/video-storage-schema.ts";
import { runMaintenancePages } from "../../services/maintenance-pages.ts";
import type { VideoServiceConfig } from "../../videos/video-config.ts";
import { storageUsage } from "../../videos/storage-policy.ts";
import { storageEffect } from "../storage-errors.ts";

export const maintainStoragePolicy = (database: Database, config: VideoServiceConfig) =>
  runMaintenancePages(
    ({ afterId, limit }) =>
      storageEffect("storage-retention", () =>
        database.db
          .select()
          .from(organizations)
          .where(
            and(
              eq(organizations.state, "active"),
              afterId ? gt(organizations.id, afterId) : undefined,
            ),
          )
          .orderBy(asc(organizations.id))
          .limit(limit)
          .all(),
      ),
    (organization) =>
      storageEffect("storage-retention", () =>
        reconcileStorageRetention(database, config, organization),
      ),
    "Storage retention policy",
  );
const reconcileStorageRetention = (
  database: Database,
  config: VideoServiceConfig,
  organization: typeof organizations.$inferSelect,
) =>
  database.db.transaction(
    (transaction) => {
      const usage = storageUsage(database, config, organization.id);
      const current = transaction
        .select()
        .from(storageSettings)
        .where(eq(storageSettings.organizationId, organization.id))
        .get();
      const over = usage.usedBytes + usage.reservedBytes > usage.includedStorageBytes;
      if (!over) {
        if (current?.graceDeadline !== null && current?.graceDeadline !== undefined)
          transaction
            .update(storageSettings)
            .set({
              graceDeadline: null,
              policyRevision: current.policyRevision + 1,
              notifiedJson: "[]",
              effectiveLimit: usage.includedStorageBytes,
              updatedAt: config.now(),
            })
            .where(eq(storageSettings.organizationId, organization.id))
            .run();
        return;
      }
      const revision =
        current?.graceDeadline == null
          ? (current?.policyRevision ?? 0) + 1
          : current.policyRevision;
      const deadline = current?.graceDeadline ?? config.now() + 30 * 86_400_000;
      transaction
        .insert(storageSettings)
        .values({
          organizationId: organization.id,
          graceDeadline: deadline,
          policyRevision: revision,
          effectiveLimit: usage.includedStorageBytes,
          updatedAt: config.now(),
        })
        .onConflictDoUpdate({
          target: storageSettings.organizationId,
          set: {
            graceDeadline: deadline,
            policyRevision: revision,
            effectiveLimit: usage.includedStorageBytes,
            updatedAt: config.now(),
          },
        })
        .run();
      queueRetentionNotices(transaction, organization, revision, deadline, config.now());
      if (deadline > config.now()) return;
      storagePurgeCandidates(database, organization.id, usage.includedStorageBytes).forEach(
        (videoId) => {
          const video = transaction.select().from(videos).where(eq(videos.id, videoId)).get();
          if (video && video.state !== "deleting")
            queueStorageDeletion(transaction, video, config.now(), {
              policyRevision: revision,
              graceDeadline: deadline,
            });
        },
      );
    },
    { behavior: "immediate" },
  );

export const queueStorageDeletion = (
  transaction: DatabaseTransaction,
  video: typeof videos.$inferSelect,
  now: number,
  reason: { policyRevision?: number; graceDeadline?: number; cleanup?: boolean; closure?: boolean },
) => {
  if (video.state === "deleting" || video.state === "deleted") return;
  const id = randomUUID();
  const revision = video.visibilityRevision + 1;
  transaction
    .update(storageTransfers)
    .set({ state: "canceled", revision, updatedAt: now })
    .where(and(eq(storageTransfers.videoId, video.id), ne(storageTransfers.state, "succeeded")))
    .run();
  transaction
    .insert(storageTransfers)
    .values({
      id,
      organizationId: video.organizationId,
      videoId: video.id,
      kind: "delete",
      state: "pending",
      revision,
      nextAttemptAt: now,
      recoveryDeadline: now + 86_400_000,
      intentJson: JSON.stringify(reason),
      idempotencyKey: `system-delete:${video.id}:${revision}`,
      requestDigest: "system",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  transitionVideo(transaction, video, {
    state: "deleting",
    transferId: id,
    visibilityRevision: revision,
    errorCode: null,
  });
  transaction
    .delete(videoAccessGrants)
    .where(
      inArray(
        videoAccessGrants.variantId,
        transaction
          .select({ id: videoVariants.id })
          .from(videoVariants)
          .where(eq(videoVariants.videoId, video.id)),
      ),
    )
    .run();
};
const queueRetentionNotices = (
  transaction: DatabaseTransaction,
  organization: typeof organizations.$inferSelect,
  revision: number,
  deadline: number,
  now: number,
) => {
  const phases = [
    "start",
    ...(deadline - now <= 7 * 86_400_000 ? ["seven-days"] : []),
    ...(deadline - now <= 86_400_000 ? ["one-day"] : []),
  ];
  const settings = transaction
    .select()
    .from(storageSettings)
    .where(eq(storageSettings.organizationId, organization.id))
    .get()!;
  const sent = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(
    settings.notifiedJson,
  );
  phases
    .filter((phase) => !sent.includes(phase))
    .forEach((phase) =>
      transaction
        .insert(emailOutbox)
        .values({
          id: randomUUID(),
          resourceKey: `storage-grace:${organization.id}:${revision}:${phase}`,
          recipient: organization.billingEmail,
          payloadJson: JSON.stringify({
            kind: "storage-retention",
            organizationId: organization.id,
            revision,
            deadline,
            phase,
          }),
          status: "pending",
          createdAt: now,
          nextAttemptAt: now,
        })
        .onConflictDoNothing()
        .run(),
    );
  transaction
    .update(storageSettings)
    .set({ notifiedJson: JSON.stringify([...new Set([...sent, ...phases])]) })
    .where(eq(storageSettings.organizationId, organization.id))
    .run();
};
