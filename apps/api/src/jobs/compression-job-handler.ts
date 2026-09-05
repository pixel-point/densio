import { decodeVideoJobOptions } from "./video-job-options.ts";
import { verifyTrimmedOutputs } from "./trim-output-verification.ts";
import { type ResolvedCompressionOptions } from "@densio/shared";
import { Effect, Schema } from "effect";

import { compressionCreditUnits } from "../billing/compression-credit-cost.ts";
import { validateMediaEntitlements } from "../media/inspection/media-entitlement-check.ts";
import { MediaProcessRunner } from "../media/process/media-process-runner.ts";
import { resolveVideoDimensions } from "../media/video-filter.ts";
import { runCompressionWorkflow } from "../media/workflows/compression-workflow.ts";
import { publishAndRegisterArtifacts } from "./artifact-publication.ts";
import {
  analysisIdentityFields,
  assertCurrentAnalysis,
  decodeJobAnalysis,
  entitlementsFor,
  inspectJob,
  meteredAnalysis,
  type JobMediaInspector,
  type MediaJobHandler,
  type MediaJobHandlerContext,
  positiveDurationSchema,
  prepareJobExecution,
  validateJobResult,
} from "./media-job-handler-support.ts";
import type { Job } from "./job-worker.ts";
import { JobProcessorError } from "./job-worker.ts";

const CompressionAnalysisSchema = Schema.Struct({
  ...analysisIdentityFields,
  audioAnalysis: Schema.Literals(["absent", "silent", "audible"]),
  durationSeconds: positiveDurationSchema,
  frameRate: Schema.Struct({
    denominator: Schema.Int.check(Schema.isGreaterThan(0)),
    numerator: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  audioStreamIndex: Schema.optionalKey(Schema.Int),
  kind: Schema.Literals(["compress", "trim"]),
});
type CompressionAnalysis = typeof CompressionAnalysisSchema.Type;

export const makeCompressionJobHandler = (
  context: MediaJobHandlerContext,
): MediaJobHandler<typeof CompressionAnalysisSchema.Type> => ({
  analyze: Effect.fn("CompressionJobHandler.analyze")((job) => analyze(context, job)),
  process: Effect.fn("CompressionJobHandler.process")((job, analysis) =>
    process(context, job, analysis),
  ),
});

const analyze = Effect.fn("CompressionJobHandler.inspect")(function* (
  context: MediaJobHandlerContext,
  job: Job,
) {
  const options = yield* decodeVideoJobOptions(job);
  const analysis = yield* inspectJob(context, job, (inspector, inputFile) =>
    inspectCompression(inspector, job, inputFile, options),
  );
  const output = resolveVideoDimensions(analysis.source, options.transform);
  const codecs = options.codecs;
  return meteredAnalysis(
    analysis,
    compressionCreditUnits({
      codecCount: codecs.length,
      durationSeconds: analysis.durationSeconds,
      output,
      source: analysis.source,
    }),
  );
});

const inspectCompression = Effect.fn("CompressionJobHandler.inspectMedia")(function* (
  inspector: JobMediaInspector,
  job: Job,
  inputFile: string,
  options: ResolvedCompressionOptions,
) {
  const media = yield* inspector.inspect(inputFile);
  yield* validateMediaEntitlements(media, options.codecs, entitlementsFor(job));
  const audioMode = options.audio;
  if (audioMode === "keep" && media.audioStreamIndexes.length === 0) {
    return yield* new JobProcessorError({
      code: "AUDIO_STREAM_REQUIRED",
      details: {},
      message: "The input does not contain an audio stream to keep.",
    });
  }
  const audioAnalysis =
    audioMode === "auto"
      ? yield* inspector.classifyAudio(
          inputFile,
          options.trim ? media.audioStreamIndexes.slice(0, 1) : media.audioStreamIndexes,
          options.trim,
        )
      : media.audioStreamIndexes.length === 0
        ? "absent"
        : "audible";
  return {
    attempt: job.attemptCount,
    audioAnalysis,
    durationSeconds: options.trim?.durationSeconds ?? media.durationSeconds,
    ...(media.audioStreamIndexes[0] === undefined
      ? {}
      : { audioStreamIndex: media.audioStreamIndexes[0] }),
    frameRate: {
      denominator: media.frameRate.denominator,
      numerator: media.frameRate.numerator,
    },
    jobId: job.id,
    kind: job.kind === "trim" ? "trim" : "compress",
    source: media.displayDimensions,
  } satisfies CompressionAnalysis;
});

const process = Effect.fn("CompressionJobHandler.execute")(function* (
  context: MediaJobHandlerContext,
  job: Job,
  input: typeof CompressionAnalysisSchema.Type,
) {
  const analysis = yield* decodeJobAnalysis(CompressionAnalysisSchema, input);
  assertCurrentAnalysis(job, analysis);
  const options = yield* decodeVideoJobOptions(job);
  const { paths, recordingRunner } = yield* prepareJobExecution(context, job);
  const workflow = yield* runCompressionWorkflow({
    bitDepth: options.bitDepth ?? 8,
    probeExecutable: context.config.ffprobePath,
    audioAnalysis: analysis.audioAnalysis,
    ...(options.trim ? { trim: options.trim } : {}),
    ...(options.trim && analysis.audioStreamIndex !== undefined
      ? { audioStreamIndex: analysis.audioStreamIndex }
      : {}),
    executable: context.config.ffmpegPath,
    paths,
    source: analysis.source,
    sourceDurationSeconds: analysis.durationSeconds,
    sourceFrameRate: analysis.frameRate,
    ...(options.audio === undefined ? {} : { audio: options.audio }),
    ...(options.codecs === undefined ? {} : { codecs: options.codecs }),
    ...(options.crf === undefined ? {} : { crf: options.crf }),
    ...(options.frameRate === undefined ? {} : { frameRate: options.frameRate }),
    ...(options.transform === undefined ? {} : { transform: options.transform }),
  }).pipe(Effect.provideService(MediaProcessRunner, recordingRunner));
  const dimensions = resolveVideoDimensions(analysis.source, options.transform);
  const outputs = yield* verifyTrimmedOutputs(
    context.config.ffprobePath,
    paths,
    workflow.outputs,
    options,
  ).pipe(Effect.provideService(MediaProcessRunner, recordingRunner));
  const published = yield* publishAndRegisterArtifacts(
    context.database,
    context.config,
    job,
    paths,
    outputs.map((output) => ({
      durationSeconds: analysis.durationSeconds,
      height: dimensions.height,
      width: dimensions.width,
      ...output,
    })),
  );
  if (job.kind === "trim")
    return yield* validateJobResult({ kind: "trim", artifactIds: published.map(({ id }) => id) });
  return yield* validateJobResult({
    artifactIds: published.map(({ id }) => id),
    html: videoHtml(
      published.map(({ filename, mediaType }) => ({ mediaType, source: `./${filename}` })),
    ),
    kind: "compress",
  });
});

const videoHtml = (
  sources: ReadonlyArray<{ readonly mediaType: string; readonly source: string }>,
) =>
  [
    '<video controls preload="metadata">',
    ...sources.map(
      ({ mediaType, source }) =>
        `  <source src="${escapeHtml(source)}" type="${escapeHtml(mediaType)}">`,
    ),
    "</video>",
  ].join("\n");

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
