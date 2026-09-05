import { transitionVideo } from "../../videos/video-lifecycle.ts";
import { eq } from "drizzle-orm";
import { Schema } from "effect";
import { storageSettings, storageTransfers, videos } from "../../database/video-storage-schema.ts";
import { storageUsage } from "../../videos/storage-policy.ts";
import type { TransferContext } from "../transfers/transfer-context.ts";

const PolicyIntent = Schema.Struct({
  policyRevision: Schema.optionalKey(Schema.Number),
  graceDeadline: Schema.optionalKey(Schema.Number),
});
const Progress = Schema.Struct({ deletionStarted: Schema.optionalKey(Schema.Boolean) });
export const beginRetentionDeletion = (context: TransferContext) =>
  context.database.db.transaction(
    (transaction) => {
      const intent = Schema.decodeUnknownSync(Schema.fromJsonString(PolicyIntent))(
        context.transfer.intentJson,
      );
      if (intent.policyRevision === undefined) return true;
      const progress = Schema.decodeUnknownSync(Schema.fromJsonString(Progress))(
        context.transfer.progressJson,
      );
      if (progress.deletionStarted) return true;
      const policy = transaction
        .select()
        .from(storageSettings)
        .where(eq(storageSettings.organizationId, context.transfer.organizationId))
        .get();
      const usage = storageUsage(context.database, context.config, context.transfer.organizationId);
      if (
        policy?.policyRevision !== intent.policyRevision ||
        policy.graceDeadline !== intent.graceDeadline ||
        (policy.graceDeadline ?? Infinity) > context.config.now() ||
        usage.usedBytes + usage.reservedBytes <= usage.includedStorageBytes
      ) {
        const video = transaction
          .select()
          .from(videos)
          .where(eq(videos.id, context.transfer.videoId))
          .get()!;
        transitionVideo(transaction, video, {
          state: video.storedAt === null ? "storage-failed" : "ready",
          errorCode: null,
        });
        transaction
          .update(storageTransfers)
          .set({ state: "canceled", errorCode: null })
          .where(eq(storageTransfers.id, context.transfer.id))
          .run();
        return false;
      }
      transaction
        .update(storageTransfers)
        .set({ progressJson: JSON.stringify({ deletionStarted: true }) })
        .where(eq(storageTransfers.id, context.transfer.id))
        .run();
      return true;
    },
    { behavior: "immediate" },
  );
