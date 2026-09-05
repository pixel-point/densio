import { acquireObjectRead } from "../storage/objects/object-read.ts";
import { Readable } from "node:stream";
import { Effect } from "effect";
import type { Database } from "../database/database.ts";
import { parseSingleRange } from "../storage/byte-range.ts";
import { storageEffect, storageFailure, storagePromise } from "../storage/storage-errors.ts";
import type { StorageWorkerConfig } from "../storage/transfers/transfer-context.ts";
import type { storageObjects } from "../database/video-storage-schema.ts";
import { findGrantedVideo } from "./video-download.ts";

export interface StoredFileRequest {
  readonly filename: string;
  readonly range?: string;
  readonly ifRange?: string;
  readonly ifNoneMatch?: string;
}
export const streamGrantedVideo = (
  database: Database,
  config: StorageWorkerConfig,
  input: StoredFileRequest & { readonly variantId: string; readonly token: string },
) =>
  streamGrantedFile(database, config, input, () =>
    findGrantedVideo(database, { ...input, now: config.now() }),
  );

export const streamGrantedFile = Effect.fn("VideoDownload.stream")(function* (
  database: Database,
  config: StorageWorkerConfig,
  input: StoredFileRequest,
  lookup: () => {
    variant: { filename: string; bytes: number; sha256: string; mediaType: string };
    object: typeof storageObjects.$inferSelect;
  },
) {
  const granted = yield* storageEffect("video-stream", lookup);
  if (input.filename !== granted.variant.filename) return yield* storageFailure("VIDEO_NOT_FOUND");
  const etag = `"sha256-${granted.variant.sha256}"`;
  const headers = { "cache-control": "private, no-store", etag, "accept-ranges": "bytes" };
  if (
    input.ifNoneMatch
      ?.split(",")
      .some((candidate) => [etag, `W/${etag}`, "*"].includes(candidate.trim()))
  )
    return new Response(null, { status: 304, headers });
  const range = yield* parseSingleRange(
    input.ifRange === undefined || input.ifRange === etag ? input.range : undefined,
    granted.variant.bytes,
  );
  return yield* storagePromise("video-stream", async (signal) => {
    const response = await acquireObjectRead(
      database,
      config,
      granted.object,
      range ? `bytes=${range.start}-${range.end}` : undefined,
      signal,
    );
    return Promise.resolve()
      .then(() => {
        const current = lookup();
        if (
          current.object.id !== granted.object.id ||
          response.etag !== granted.object.etag ||
          response.bytes !== (range?.length ?? granted.variant.bytes)
        ) {
          throw storageFailure("STORAGE_OBJECT_CHANGED");
        }
        return new Response(leasedBody(response.body, response.release), {
          status: range ? 206 : 200,
          headers: {
            ...headers,
            "content-type": granted.variant.mediaType,
            "content-length": String(range?.length ?? granted.variant.bytes),
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(granted.variant.filename)}`,
            ...(range ? { "content-range": range.contentRange } : {}),
          },
        });
      })
      .catch((error: unknown) => {
        response.release();
        throw error;
      });
  });
});

const leasedBody = (body: Readable, release: () => void) => {
  const reader = Readable.toWeb(body).getReader();
  let released = false;
  const finish = () => {
    if (released) return;
    released = true;
    release();
  };
  return new ReadableStream<Uint8Array>({
    pull: (controller) =>
      reader
        .read()
        .then(({ done, value }) => {
          if (!done) return controller.enqueue(value);
          controller.close();
          finish();
        })
        .catch((error: unknown) => {
          controller.error(error);
          finish();
        }),
    cancel: (reason) => reader.cancel(reason).finally(finish),
  });
};
