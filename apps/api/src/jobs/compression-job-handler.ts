import {
  CompressionOptionsSchema,
  DEFAULT_COMPRESSION_CODECS,
  type CompressionOptions,
  type JobDecision,
} from "@densio/shared";
import { Effect, Schema } from "effect";

import { compressionCreditUnits } from "../billing/compression-credit-cost.ts";
import { validateMediaEntitlements } from "../media/inspection/media-entitlement-check.ts";
import type { MediaInspector } from "../media/inspection/media-inspector.ts";
import { MediaProcessRunner } from "../media/process/media-process-runner.ts";
import { requiresFrameRateDecision } from "../media/frame-rate.ts";
import { resolveVideoDimensions } from "../media/video-filter.ts";
import { runCompressionWorkflow } from "../media/workflows/compression-workflow.ts";
import { publishAndRegisterArtifacts } from "./artifact-publication.ts";
import {
  analysisIdentityFields,
  assertCurrentAnalysis,
  decodeJobAnalysis,
  decodeJobOptions,
  entitlementsFor,
  inspectJob,
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

const CompressionAnalysisSchema = Schema.Struct({
  ...analysisIdentityFields,
  audioAnalysis: Schema.Literals(["absent", "silent", "audible"]),
  durationSeconds: positiveDurationSchema,
  frameRate: Schema.Struct({
    denominator: Schema.Int.check(Schema.isGreaterThan(0)),
    numerator: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  kind: Schema.Literal("compress"),
});
type CompressionAnalysis = typeof CompressionAnalysisSchema.Type;

export const makeCompressionJobHandler = (context: MediaJobHandlerContext): MediaJobHandler => ({
  analyze: Effect.fn("CompressionJobHandler.analyze")((job) => analyze(context, job)),
  process: Effect.fn("CompressionJobHandler.process")((job, analysis) =>
    process(context, job, analysis),
  ),
});

const analyze = Effect.fn("CompressionJobHandler.inspect")(function* (
  context: MediaJobHandlerContext,
  job: Job,
) {
  const options = yield* decodeJobOptions(CompressionOptionsSchema, job.optionsJson, "compression");
  const analysis = yield* inspectJob(context, job, (inspector, inputFile) =>
    inspectCompression(inspector, job, inputFile, options),
  );
  if (analysis.kind === "decision-required") return analysis;
  const output = resolveVideoDimensions(analysis.source, options.transform);
  const codecs = options.codecs ?? DEFAULT_COMPRESSION_CODECS;
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
  inspector: MediaInspector["Service"],
  job: Job,
  inputFile: string,
  options: CompressionOptions,
) {
  const media = yield* inspector.inspect(inputFile);
  yield* validateMediaEntitlements(
    media,
    options.codecs ?? DEFAULT_COMPRESSION_CODECS,
    entitlementsFor(job),
  );
  const audioMode = options.audio ?? "auto";
  if (audioMode === "keep" && media.audioStreamIndexes.length === 0) {
    return yield* new JobProcessorError({
      code: "AUDIO_STREAM_REQUIRED",
      details: {},
      message: "The input does not contain an audio stream to keep.",
    });
  }
  if (options.frameRate === undefined && requiresFrameRateDecision(media.frameRate)) {
    return {
      decision: {
        kind: "frame-rate",
        recommended: { maximum: 30, mode: "cap" },
        source: media.frameRate,
      } satisfies JobDecision,
      kind: "decision-required",
    } as const;
  }
  const audioAnalysis =
    audioMode === "auto"
      ? yield* inspector.classifyAudio(inputFile, media.audioStreamIndexes)
      : media.audioStreamIndexes.length === 0
        ? "absent"
        : "audible";
  return {
    attempt: job.attemptCount,
    audioAnalysis,
    durationSeconds: media.durationSeconds,
    frameRate: {
      denominator: media.frameRate.denominator,
      numerator: media.frameRate.numerator,
    },
    jobId: job.id,
    kind: "compress",
    source: media.displayDimensions,
  } satisfies CompressionAnalysis;
});

const process = Effect.fn("CompressionJobHandler.execute")(function* (
  context: MediaJobHandlerContext,
  job: Job,
  input: Schema.Json,
) {
  const analysis = yield* decodeJobAnalysis(CompressionAnalysisSchema, input);
  assertCurrentAnalysis(job, analysis);
  const options = yield* decodeJobOptions(CompressionOptionsSchema, job.optionsJson, "compression");
  const { paths, recordingRunner } = yield* prepareJobExecution(context, job);
  const workflow = yield* runCompressionWorkflow({
    audioAnalysis: analysis.audioAnalysis,
    executable: context.config.ffmpegPath,
    paths,
    source: analysis.source,
    sourceFrameRate: analysis.frameRate,
    ...(options.audio === undefined ? {} : { audio: options.audio }),
    ...(options.codecs === undefined ? {} : { codecs: options.codecs }),
    ...(options.crf === undefined ? {} : { crf: options.crf }),
    ...(options.frameRate === undefined ? {} : { frameRate: options.frameRate }),
    ...(options.transform === undefined ? {} : { transform: options.transform }),
  }).pipe(Effect.provideService(MediaProcessRunner, recordingRunner));
  const published = yield* publishAndRegisterArtifacts(
    context.database,
    context.config,
    job,
    paths,
    workflow.outputs,
  );
  return yield* validateJobResult({
    artifacts: published,
    commands: sanitizeCommands(workflow.commands),
    html: videoHtml(published),
    kind: "compress",
  });
});

const videoHtml = (
  published: ReadonlyArray<{ readonly downloadUrl: string; readonly mediaType: string }>,
) =>
  [
    '<video controls preload="metadata">',
    ...published.map(
      (artifact) =>
        `  <source src="${escapeHtml(artifact.downloadUrl)}" type="${escapeHtml(artifact.mediaType)}">`,
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
