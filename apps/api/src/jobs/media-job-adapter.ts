import { rm } from "node:fs/promises";

import type { JobWorkflow } from "@ffmpeg-api/shared";
import { eq } from "drizzle-orm";
import { Effect, Exit } from "effect";

import type { Database } from "../database/database.ts";
import { artifacts } from "../database/schema.ts";
import { MediaProcessRunner } from "../media/process/media-process-runner.ts";
import { cleanupJobWorkspace, makeJobStoragePaths } from "../storage/workspace.ts";
import { makeCompressionJobHandler } from "./compression-job-handler.ts";
import { makeImageExtractionJobHandler } from "./image-extraction-job-handler.ts";
import {
  adaptMediaJobErrors,
  type MediaJobAdapterConfig,
  type MediaJobHandler,
  type MediaJobHandlerContext,
} from "./media-job-handler-support.ts";
import { JobCleanup, type Job, JobProcessor } from "./job-worker.ts";
import { makeQualityComparisonJobHandler } from "./quality-comparison-job-handler.ts";

export type { MediaJobAdapterConfig } from "./media-job-handler-support.ts";

export const makeMediaJobProcessor = (
  database: Database,
  config: MediaJobAdapterConfig,
  runner: MediaProcessRunner["Service"],
) => {
  const handlers = makeHandlers({ config, database, runner });
  return JobProcessor.of({
    analyze: Effect.fn("MediaJobProcessor.analyze")((job) =>
      adaptMediaJobErrors(handlers[job.kind].analyze(job)),
    ),
    process: Effect.fn("MediaJobProcessor.process")((job, analysis) =>
      adaptMediaJobErrors(handlers[job.kind].process(job, analysis)),
    ),
  });
};

export const makeMediaJobCleanup = (database: Database, config: MediaJobAdapterConfig) =>
  JobCleanup.of({
    cleanup: Effect.fn("MediaJobCleanup.cleanup")(function* (job: Job) {
      const paths = yield* makeJobStoragePaths(config.mediaRoot, job.id).pipe(Effect.orDie);
      const operations = [cleanupJobWorkspace(paths).pipe(Effect.orDie)];
      const terminalCleanup =
        job.state === "succeeded"
          ? operations
          : [
              deleteArtifactRows(database, job.id),
              removeArtifactDirectory(paths.artifactDirectory),
              ...operations,
            ];
      const outcomes = yield* Effect.forEach(terminalCleanup, Effect.exit);
      if (outcomes.some(Exit.isFailure)) {
        yield* Effect.logError("One or more media job cleanup operations failed.");
      }
    }),
  });

const makeHandlers = (context: MediaJobHandlerContext): Record<JobWorkflow, MediaJobHandler> => ({
  "compare-quality": makeQualityComparisonJobHandler(context),
  compress: makeCompressionJobHandler(context),
  "extract-images": makeImageExtractionJobHandler(context),
});

const deleteArtifactRows = (database: Database, jobId: string) =>
  Effect.sync(() => database.db.delete(artifacts).where(eq(artifacts.jobId, jobId)).run()).pipe(
    Effect.orDie,
  );

const removeArtifactDirectory = (directory: string) =>
  Effect.tryPromise(() => rm(directory, { force: true, recursive: true })).pipe(Effect.orDie);
