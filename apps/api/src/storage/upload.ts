import { createHash } from "node:crypto";
import { open, rm } from "node:fs/promises";

import { Effect, Schema } from "effect";

import { StorageOperationError } from "./workspace.ts";

export class UploadLimitExceeded extends Schema.TaggedErrorClass<UploadLimitExceeded>()(
  "UploadLimitExceeded",
  {
    limitBytes: Schema.Number,
    message: Schema.String,
    receivedBytes: Schema.Number,
  },
) {}

export class UploadSizeMismatch extends Schema.TaggedErrorClass<UploadSizeMismatch>()(
  "UploadSizeMismatch",
  {
    declaredBytes: Schema.Number,
    message: Schema.String,
    receivedBytes: Schema.Number,
  },
) {}

type StoreUploadOptions = Readonly<{
  body: ReadableStream<Uint8Array>;
  declaredBytes?: number;
  destination: string;
  maxBytes: number;
}>;

const limitExceeded = (limitBytes: number, receivedBytes: number) =>
  new UploadLimitExceeded({
    limitBytes,
    message: "The uploaded file exceeds the allowed size.",
    receivedBytes,
  });

const writeChunk = async (file: Awaited<ReturnType<typeof open>>, chunk: Uint8Array) => {
  let offset = 0;

  while (offset < chunk.byteLength) {
    const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset, null);
    offset += bytesWritten;
  }
};

const streamUpload = async ({ body, declaredBytes, destination, maxBytes }: StoreUploadOptions) => {
  const file = await open(destination, "wx");
  const reader = body.getReader();
  const digest = createHash("sha256");
  let bytes = 0;
  let completed = false;

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;

      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw limitExceeded(maxBytes, bytes);

      digest.update(chunk.value);
      await writeChunk(file, chunk.value);
    }

    if (declaredBytes !== undefined && bytes !== declaredBytes) {
      throw new UploadSizeMismatch({
        declaredBytes,
        message: "The uploaded size does not match the declared size.",
        receivedBytes: bytes,
      });
    }

    completed = true;
    return { bytes, sha256: digest.digest("hex") } as const;
  } finally {
    await Promise.allSettled([
      file.close(),
      completed ? Promise.resolve() : rm(destination, { force: true }),
      completed ? Promise.resolve() : reader.cancel(),
    ]);
    reader.releaseLock();
  }
};

const mapUploadError = (cause: unknown) => {
  if (cause instanceof UploadLimitExceeded || cause instanceof UploadSizeMismatch) return cause;

  return new StorageOperationError({
    message: "The upload could not be stored.",
    operation: "store-upload",
  });
};

export const storeUpload = Effect.fn("Storage.storeUpload")(function* (
  options: StoreUploadOptions,
) {
  if (options.declaredBytes !== undefined && options.declaredBytes > options.maxBytes) {
    return yield* limitExceeded(options.maxBytes, options.declaredBytes);
  }

  return yield* Effect.tryPromise({
    catch: mapUploadError,
    try: () => streamUpload(options),
  });
});
