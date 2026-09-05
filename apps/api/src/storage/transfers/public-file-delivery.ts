import { eq } from "drizzle-orm";
import { storageObjects } from "../../database/video-storage-schema.ts";
import { publicObjectUrl } from "../../videos/video-catalog.ts";
import type { TransferContext } from "./transfer-context.ts";
import type { StorageFile } from "./storage-files.ts";

export type TransferredStorageFile = { file: StorageFile; objectId: string };

export const verifyTransferredPublicFiles = async (
  context: TransferContext,
  video: { publicOrigin: string | null; connectionId: string | null },
  files: readonly TransferredStorageFile[],
) => {
  const deliveries = files.map((entry) => ({
    ...entry,
    url: publicObjectUrl(video.publicOrigin ?? "", entry.file.publicKey),
  }));
  // Missing objects can be cached before publication or while a video is private.
  if (video.connectionId === null)
    await context.config.purge(
      deliveries.map(({ url }) => url),
      context.signal,
    );
  for (const { file, objectId, url } of deliveries) {
    await context.config.verifyPublic(
      url,
      file.bytes,
      file.mediaType,
      context.signal,
      file.kind === "hls",
    );
    context.assertActive();
    context.database.db
      .update(storageObjects)
      .set({ publicUrl: url })
      .where(eq(storageObjects.id, objectId))
      .run();
  }
};
