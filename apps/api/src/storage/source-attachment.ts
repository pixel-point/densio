import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, rm } from "node:fs/promises";
import { Readable } from "node:stream";

import { Effect, Result, Schema } from "effect";

import { publishStoredUpload, storeUpload, verifyStoredUpload } from "./upload.ts";
import { makeJobStoragePaths, prepareJobWorkspace } from "./workspace.ts";
import { makeSourceStoragePaths } from "./source-workspace.ts";

type LinkFile = (source: string, destination: string) => Promise<void>;

interface AttachPreparedSourceInput {
  readonly expected: { readonly bytes: number; readonly sha256: string };
  readonly jobId: string;
  readonly linkFile?: LinkFile;
  readonly mediaRoot: string;
  readonly sourceId: string;
}

export class SourceAttachmentError extends Schema.TaggedErrorClass<SourceAttachmentError>()(
  "SourceAttachmentError",
  { message: Schema.String, operation: Schema.String, retryable: Schema.Boolean },
) {}

const attachmentError = (operation: string, retryable = false) =>
  new SourceAttachmentError({
    message: "The prepared source could not be attached to the job.",
    operation,
    retryable,
  });

export const attachPreparedSource = Effect.fn("SourceAttachment.attach")(function* (
  input: AttachPreparedSourceInput,
) {
  const sourcePaths = yield* makeSourceStoragePaths(input.mediaRoot, input.sourceId);
  const sourceIsValid = yield* verifyStoredUpload(sourcePaths.inputFile, input.expected);
  if (!sourceIsValid) return yield* attachmentError("verify-source");

  const jobPaths = yield* makeJobStoragePaths(input.mediaRoot, input.jobId);
  yield* prepareJobWorkspace(jobPaths);
  const inputMode = yield* linkPreparedSource(
    sourcePaths.inputFile,
    jobPaths.inputFile,
    input.expected,
    input.linkFile ?? link,
  );
  const attachedIsValid = yield* verifyStoredUpload(jobPaths.inputFile, input.expected);
  if (!attachedIsValid) {
    yield* removeAttachment(jobPaths.inputFile);
    return yield* attachmentError("verify-attachment");
  }
  return { ...input.expected, inputFile: jobPaths.inputFile, inputMode } as const;
});

const linkPreparedSource = Effect.fn("SourceAttachment.linkOrCopy")(function* (
  source: string,
  destination: string,
  expected: { readonly bytes: number; readonly sha256: string },
  linkFile: LinkFile,
) {
  const linked = yield* Effect.tryPromise({
    catch: (cause) => cause,
    try: () => linkFile(source, destination),
  }).pipe(Effect.uninterruptible, Effect.result);
  if (Result.isSuccess(linked)) return "hard-link" as const;
  if (yield* verifyStoredUpload(destination, expected)) return "hard-link" as const;
  if (!isCopyFallbackError(linked.failure))
    return yield* attachmentError("link-source", !isExistingFile(linked.failure));

  const stagingPath = `${destination}.attachment-${randomUUID()}`;
  const body = Readable.toWeb(createReadStream(source)) as ReadableStream<Uint8Array>;
  yield* Effect.gen(function* () {
    const copied = yield* storeUpload({
      body,
      declaredBytes: expected.bytes,
      destination: stagingPath,
      maxBytes: expected.bytes,
    });
    if (copied.sha256 !== expected.sha256) return yield* attachmentError("verify-copy");
    const published = yield* publishStoredUpload(stagingPath, destination).pipe(Effect.result);
    if (Result.isFailure(published) && !(yield* verifyStoredUpload(destination, expected)))
      return yield* attachmentError("publish-copy", true);
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof SourceAttachmentError ? cause : attachmentError("copy-source", true),
    ),
    Effect.ensuring(
      removeAttachment(stagingPath).pipe(
        Effect.catch(() =>
          Effect.logWarning(
            "Source attachment staging cleanup will be retried with workspace cleanup.",
          ),
        ),
      ),
    ),
  );
  return "copy" as const;
});

const isCopyFallbackError = (cause: unknown) =>
  cause instanceof Error &&
  "code" in cause &&
  ["EACCES", "EMLINK", "ENOTSUP", "EPERM", "EXDEV"].includes(String(cause.code));

const isExistingFile = (cause: unknown) =>
  cause instanceof Error && "code" in cause && cause.code === "EEXIST";

const removeAttachment = (path: string) =>
  Effect.tryPromise({
    catch: () => attachmentError("remove-attachment", true),
    try: () => rm(path, { force: true }),
  });
