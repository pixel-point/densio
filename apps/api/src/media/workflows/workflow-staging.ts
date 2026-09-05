import { mkdir, rm } from "node:fs/promises";

import { Effect, Schema } from "effect";

import {
  type JobStoragePaths,
  prepareJobWorkspace,
  resolveStagedFile,
} from "../../storage/workspace.ts";

export class MediaWorkflowFileError extends Schema.TaggedErrorClass<MediaWorkflowFileError>()(
  "MediaWorkflowFileError",
  {
    message: Schema.String,
    operation: Schema.String,
  },
) {}

export const workflowFileOperation = <Value>(operation: string, run: () => Promise<Value>) =>
  Effect.tryPromise({
    catch: () =>
      new MediaWorkflowFileError({
        message: "The media workflow file operation failed.",
        operation,
      }),
    try: run,
  }).pipe(Effect.uninterruptible);

export const resetWorkflowStaging = Effect.fn("MediaWorkflow.resetStaging")(function* (
  paths: JobStoragePaths,
) {
  yield* resolveStagedFile(paths, "workflow-guard");
  yield* prepareJobWorkspace(paths);
  yield* workflowFileOperation("reset-staging", async () => {
    await rm(paths.stagingDirectory, { force: true, recursive: true });
    await mkdir(paths.stagingDirectory, { recursive: true });
  }).pipe(Effect.asVoid);
});

export const cleanupWorkflowStaging = Effect.fn("MediaWorkflow.cleanupStaging")(function* (
  paths: JobStoragePaths,
) {
  yield* resolveStagedFile(paths, "workflow-guard");
  yield* workflowFileOperation("cleanup-staging", () =>
    rm(paths.stagingDirectory, { force: true, recursive: true }),
  ).pipe(Effect.asVoid);
});

export const withWorkflowFailureCleanup = <A, E, R>(
  paths: JobStoragePaths,
  effect: Effect.Effect<A, E, R>,
) => effect.pipe(Effect.onError(() => cleanupWorkflowStaging(paths).pipe(Effect.ignore)));
