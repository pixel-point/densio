import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { UploadLimitExceeded, UploadSizeMismatch, storeUpload } from "../src/storage/upload.ts";
import { StorageOperationError } from "../src/storage/workspace.ts";

const temporaryRoots: Array<string> = [];
const encoder = new TextEncoder();

const makeDestination = async () => {
  const root = await mkdtemp(join(tmpdir(), "densio-upload-"));
  temporaryRoots.push(root);
  return join(root, "source-video");
};

const streamChunks = (...chunks: ReadonlyArray<string>) => {
  let index = 0;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunk));
    },
  });
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("streamed uploads", () => {
  it("streams chunks to disk while calculating bytes and SHA-256", async () => {
    const destination = await makeDestination();

    const stored = await Effect.runPromise(
      storeUpload({
        body: streamChunks("hello", " ", "world"),
        declaredBytes: 11,
        destination,
        maxBytes: 20,
      }),
    );

    expect(stored).toEqual({
      bytes: 11,
      sha256: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    });
    await expect(readFile(destination, "utf8")).resolves.toBe("hello world");
  });

  it("rejects a declared size above the limit before consuming the body", async () => {
    const destination = await makeDestination();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(encoder.encode("oversized"));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );

    const error = await Effect.runPromise(
      Effect.flip(storeUpload({ body, declaredBytes: 9, destination, maxBytes: 8 })),
    );

    expect(error).toBeInstanceOf(UploadLimitExceeded);
    expect(error).toMatchObject({ limitBytes: 8, receivedBytes: 9 });
    expect(pulls).toBe(0);
    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("failed streamed uploads", () => {
  it("deletes a partial file when streamed bytes exceed the limit", async () => {
    const destination = await makeDestination();

    const error = await Effect.runPromise(
      Effect.flip(
        storeUpload({
          body: streamChunks("1234", "5678"),
          destination,
          maxBytes: 6,
        }),
      ),
    );

    expect(error).toBeInstanceOf(UploadLimitExceeded);
    expect(error).toMatchObject({ limitBytes: 6, receivedBytes: 8 });
    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deletes the file when the received size differs from the declaration", async () => {
    const destination = await makeDestination();

    const error = await Effect.runPromise(
      Effect.flip(
        storeUpload({
          body: streamChunks("short"),
          declaredBytes: 7,
          destination,
          maxBytes: 10,
        }),
      ),
    );

    expect(error).toBeInstanceOf(UploadSizeMismatch);
    expect(error).toMatchObject({ declaredBytes: 7, receivedBytes: 5 });
    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("maps stream failures and removes the partial file", async () => {
    const destination = await makeDestination();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("partial"));
        controller.error(new Error("connection reset"));
      },
    });

    const error = await Effect.runPromise(
      Effect.flip(storeUpload({ body, destination, maxBytes: 20 })),
    );

    expect(error).toBeInstanceOf(StorageOperationError);
    expect(error).toMatchObject({ operation: "store-upload" });
    await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never deletes a destination that existed before the upload", async () => {
    const destination = await makeDestination();
    await writeFile(destination, "existing");

    const error = await Effect.runPromise(
      Effect.flip(storeUpload({ body: streamChunks("new"), destination, maxBytes: 20 })),
    );

    expect(error).toBeInstanceOf(StorageOperationError);
    await expect(readFile(destination, "utf8")).resolves.toBe("existing");
  });
});
