import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, open, rm, stat } from "node:fs/promises";

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

const streamUpload = async (
  { body, declaredBytes, destination, maxBytes }: StoreUploadOptions,
  signal: AbortSignal,
) => {
  const file = await open(destination, "wx");
  const reader = body.getReader();
  const digest = createHash("sha256");
  let bytes = 0;
  let completed = false;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });

  try {
    if (signal.aborted) cancel();
    while (true) {
      const chunk = await reader.read();
      signal.throwIfAborted();
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
    signal.removeEventListener("abort", cancel);
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

  return yield* Effect.callback<
    Awaited<ReturnType<typeof streamUpload>>,
    ReturnType<typeof mapUploadError>
  >((resume) => {
    const controller = new AbortController();
    const running = streamUpload(options, controller.signal);
    void running.then(
      (result) => resume(Effect.succeed(result)),
      (error: unknown) => resume(Effect.fail(mapUploadError(error))),
    );
    // A canceled Effect must not release its durable writer claim while a native
    // promise can still write. Cancel the reader and await actual file closure.
    return Effect.promise(async () => {
      controller.abort();
      await running.catch(() => undefined);
    });
  });
});

export const verifyStoredUpload = Effect.fn("Storage.verifyStoredUpload")(function* (
  path: string,
  expected: { readonly bytes: number; readonly sha256: string },
) {
  const verified = yield* Effect.tryPromise({
    catch: (cause) => cause,
    try: async () => {
      const metadata = await stat(path);
      if (metadata.size !== expected.bytes) return false;

      const digest = createHash("sha256");
      for await (const chunk of createReadStream(path)) digest.update(chunk);
      return digest.digest("hex") === expected.sha256;
    },
  }).pipe(
    Effect.catch((cause) =>
      isMissingFile(cause)
        ? Effect.succeed(false)
        : Effect.fail(
            new StorageOperationError({
              message: "The stored upload could not be verified.",
              operation: "verify-upload",
            }),
          ),
    ),
  );

  return verified;
});

const isMissingFile = (cause: unknown) =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

export const publishStoredUpload = (stagingPath: string, destination: string) =>
  Effect.tryPromise({
    catch: () =>
      new StorageOperationError({
        message: "The stored upload could not be published.",
        operation: "publish-upload",
      }),
    try: async () => {
      await link(stagingPath, destination);
      await rm(stagingPath);
    },
  }).pipe(Effect.uninterruptible);

export const removeStoredUpload = (path: string) =>
  Effect.tryPromise({
    catch: () =>
      new StorageOperationError({
        message: "The stored upload could not be removed.",
        operation: "remove-upload",
      }),
    try: () => rm(path, { force: true }),
  });
