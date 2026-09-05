import type { JobWorkflow } from "@densio/shared";
import { Effect } from "effect";

import type { Database } from "../database/database.ts";
import { MediaProcessRunner } from "../media/process/media-process-runner.ts";
import { makeCompressionJobHandler } from "./compression-job-handler.ts";
import { makeHlsJobHandler } from "./hls-job-handler.ts";
import { makeImageExtractionJobHandler } from "./image-extraction-job-handler.ts";
import {
  adaptMediaJobErrors,
  type MediaJobAdapterConfig,
  type MediaJobHandler,
  type MediaJobHandlerContext,
} from "./media-job-handler-support.ts";
import {
  JobCleanup,
  type Job,
  type JobAnalysis,
  type JobProcessorError,
  JobProcessor,
} from "./job-worker.ts";
import { makeQualityComparisonJobHandler } from "./quality-comparison-job-handler.ts";
import { cleanupTerminalJob } from "./terminal-workspace-cleanup.ts";

export type { MediaJobAdapterConfig } from "./media-job-handler-support.ts";

export const makeMediaJobProcessor = (
  database: Database,
  config: MediaJobAdapterConfig,
  runner: MediaProcessRunner["Service"],
) => {
  const handlers = makeHandlers({ config, database, runner });
  return JobProcessor.of({ analyze: (job) => handlers[job.kind](job) });
};

export const makeMediaJobCleanup = (database: Database, config: MediaJobAdapterConfig) =>
  JobCleanup.of({
    cleanup: (job: Job) =>
      cleanupTerminalJob(database, config.mediaRoot, job.id).pipe(
        Effect.catchCause(() => Effect.logError("Media job cleanup remains pending for retry.")),
      ),
  });

const prepareHandler =
  <Analysis>(handler: MediaJobHandler<Analysis>) =>
  (job: Job) =>
    adaptMediaJobErrors(handler.analyze(job)).pipe(
      Effect.map(
        (analysis): JobAnalysis => ({
          kind: "ready",
          creditUnits: analysis.creditUnits,
          process: (currentJob) => adaptMediaJobErrors(handler.process(currentJob, analysis.data)),
        }),
      ),
    );

const makeHandlers = (
  context: MediaJobHandlerContext,
): Record<JobWorkflow, (job: Job) => Effect.Effect<JobAnalysis, JobProcessorError>> => ({
  hls: prepareHandler(makeHlsJobHandler(context)),
  "compare-quality": prepareHandler(makeQualityComparisonJobHandler(context)),
  compress: prepareHandler(makeCompressionJobHandler(context)),
  trim: prepareHandler(makeCompressionJobHandler(context)),
  "extract-images": prepareHandler(makeImageExtractionJobHandler(context)),
});
