import { eq } from "drizzle-orm";
import { storageObjects } from "../../database/video-storage-schema.ts";
import { objectHasConsumers } from "./object-consumers.ts";
import { storageFailure } from "../storage-errors.ts";
import type { TransferContext } from "./transfer-context.ts";

export const removeStoredObject = async (
  context: TransferContext,
  object: typeof storageObjects.$inferSelect,
) => {
  if (object.state === "deleted") return true;
  if (objectHasConsumers(context.database.db, object.id, context.config)) return false;
  context.assertActive();
  const target = await context.config.resolveTarget(object.targetId, object.bucketRole);
  if (object.uploadId !== null)
    await target.store.abort(object.objectKey, object.uploadId, context.signal);
  const unknownSessions =
    object.state === "creating"
      ? await target.store.listMultipart(object.objectKey, context.signal)
      : [];
  if (object.state === "creating" && unknownSessions.length === 0)
    throw storageFailure(
      "STORAGE_BUSY",
      "An unresolved multipart creation prevents confirmed deletion.",
    );
  for (const session of unknownSessions)
    await target.store.abort(object.objectKey, session.uploadId, context.signal);
  context.assertActive();
  context.database.db
    .update(storageObjects)
    .set({ state: "deleting" })
    .where(eq(storageObjects.id, object.id))
    .run();
  await target.store.remove(object.objectKey, object.versionId ?? undefined, context.signal);
  if (
    (await target.store.head(object.objectKey, object.versionId ?? undefined, context.signal)) !==
    null
  )
    throw storageFailure("STORAGE_DELETION_BLOCKED");
  if (object.publicUrl !== null) {
    if (object.purgedAt === null) {
      if (!object.targetId.startsWith("connection:"))
        await context.config.purge([object.publicUrl], context.signal);
      context.database.db
        .update(storageObjects)
        .set({ purgedAt: context.config.now(), purgeAfter: context.config.now() + 60_000 })
        .where(eq(storageObjects.id, object.id))
        .run();
      return false;
    }
    if ((object.purgeAfter ?? 0) > context.config.now()) return false;
  }
  context.assertActive();
  context.database.db
    .update(storageObjects)
    .set({ state: "deleted", deletedAt: context.config.now() })
    .where(eq(storageObjects.id, object.id))
    .run();
  return true;
};
