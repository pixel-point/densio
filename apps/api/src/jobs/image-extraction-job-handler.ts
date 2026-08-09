import { ExtractImagesOptionsSchema, type ExtractImagesOptions } from "@ffmpeg-api/shared";
import { Effect, Schema } from "effect";

import { validateMediaEntitlements } from "../media/inspection/media-entitlement-check.ts";
import type { MediaInspector } from "../media/inspection/media-inspector.ts";
import { MediaProcessRunner } from "../media/process/media-process-runner.ts";
import { runImageExtractionWorkflow } from "../media/workflows/image-extraction-workflow.ts";
import { publishAndRegisterArtifacts } from "./artifact-publication.ts";
import {
  analysisIdentityFields,
  assertCurrentAnalysis,
  decodeJobAnalysis,
  decodeJobOptions,
  entitlementsFor,
  inspectJob,
  invalidJobResult,
  meteredAnalysis,
  type MediaJobHandler,
  type MediaJobHandlerContext,
  positiveDurationSchema,
  prepareJobExecution,
  sanitizeCommands,
  validateJobResult,
} from "./media-job-handler-support.ts";
import type { Job } from "./job-worker.ts";
import { JobProcessorError } from "./job-worker.ts";

const ImageExtractionAnalysisSchema = Schema.Struct({
  ...analysisIdentityFields,
  durationSeconds: positiveDurationSchema,
  kind: Schema.Literal("extract-images"),
});
type ImageExtractionAnalysis = typeof ImageExtractionAnalysisSchema.Type;

export const makeImageExtractionJobHandler = (
  context: MediaJobHandlerContext,
): MediaJobHandler => ({
  analyze: Effect.fn("ImageExtractionJobHandler.analyze")((job) => analyze(context, job)),
  process: Effect.fn("ImageExtractionJobHandler.process")((job, analysis) =>
    process(context, job, analysis),
  ),
});

const analyze = Effect.fn("ImageExtractionJobHandler.inspect")(function* (
  context: MediaJobHandlerContext,
  job: Job,
) {
  const options = yield* decodeJobOptions(
    ExtractImagesOptionsSchema,
    job.optionsJson,
    "image extraction",
  );
  const analysis = yield* inspectJob(context, job, (inspector, inputFile) =>
    inspectExtraction(inspector, job, inputFile, options, context.config.maxExtractedImages),
  );
  return meteredAnalysis(analysis);
});

const inspectExtraction = Effect.fn("ImageExtractionJobHandler.inspectMedia")(function* (
  inspector: MediaInspector["Service"],
  job: Job,
  inputFile: string,
  options: ExtractImagesOptions,
  maxExtractedImages: number,
) {
  const media = yield* inspector.inspect(inputFile);
  yield* validateMediaEntitlements(media, [], entitlementsFor(job));
  const estimatedImages = Math.ceil(media.durationSeconds / (options.intervalSeconds ?? 1));
  if (estimatedImages > maxExtractedImages) {
    return yield* new JobProcessorError({
      code: "EXTRACTED_IMAGE_LIMIT_EXCEEDED",
      details: { estimatedImages, maxExtractedImages },
      message: "The requested interval would extract too many images.",
    });
  }
  return {
    attempt: job.attemptCount,
    durationSeconds: media.durationSeconds,
    jobId: job.id,
    kind: "extract-images",
    source: media.displayDimensions,
  } satisfies ImageExtractionAnalysis;
});

const process = Effect.fn("ImageExtractionJobHandler.execute")(function* (
  context: MediaJobHandlerContext,
  job: Job,
  input: Schema.Json,
) {
  const analysis = yield* decodeJobAnalysis(ImageExtractionAnalysisSchema, input);
  assertCurrentAnalysis(job, analysis);
  const options = yield* decodeJobOptions(
    ExtractImagesOptionsSchema,
    job.optionsJson,
    "image extraction",
  );
  const { paths, recordingRunner } = yield* prepareJobExecution(context, job);
  const workflow = yield* runImageExtractionWorkflow({
    executable: context.config.ffmpegPath,
    paths,
    source: analysis.source,
    sourceDurationSeconds: analysis.durationSeconds,
    ...(options.format === undefined ? {} : { format: options.format }),
    ...(options.intervalSeconds === undefined ? {} : { intervalSeconds: options.intervalSeconds }),
    ...(options.transform === undefined ? {} : { transform: options.transform }),
  }).pipe(Effect.provideService(MediaProcessRunner, recordingRunner));
  const [archive] = yield* publishAndRegisterArtifacts(
    context.database,
    context.config,
    job,
    paths,
    [workflow.archive],
  );
  if (archive === undefined || archive.kind !== "image-archive") {
    return yield* invalidJobResult();
  }
  return yield* validateJobResult({
    archive: { ...archive, kind: "image-archive" },
    commands: sanitizeCommands(workflow.commands),
    imageCount: workflow.imageCount,
    intervalSeconds: workflow.intervalSeconds,
    kind: "extract-images",
  });
});
