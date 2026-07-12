import { CompressionOptionsSchema, type CompressionOptions } from "@ffmpeg-api/shared";
import { Effect, Schema } from "effect";

import { validateMediaEntitlements } from "../media/inspection/media-entitlement-check.ts";
import type { MediaInspector } from "../media/inspection/media-inspector.ts";
import { MediaProcessRunner } from "../media/process/media-process-runner.ts";
import { runCompressionWorkflow } from "../media/workflows/compression-workflow.ts";
import { publishAndRegisterArtifacts } from "./artifact-publication.ts";
import {
  analysisIdentityFields,
  assertCurrentAnalysis,
  decodeJobAnalysis,
  decodeJobOptions,
  entitlementsFor,
  inspectJob,
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
  return yield* inspectJob(context, job, (inspector, inputFile) =>
    inspectCompression(inspector, job, inputFile, options),
  );
});

const inspectCompression = Effect.fn("CompressionJobHandler.inspectMedia")(function* (
  inspector: MediaInspector["Service"],
  job: Job,
  inputFile: string,
  options: CompressionOptions,
) {
  const media = yield* inspector.inspect(inputFile);
  yield* validateMediaEntitlements(media, options.codecs ?? ["vp9", "h265"], entitlementsFor(job));
  const audioMode = options.audio ?? "auto";
  if (audioMode === "keep" && media.audioStreamIndexes.length === 0) {
    return yield* new JobProcessorError({
      code: "AUDIO_STREAM_REQUIRED",
      details: {},
      message: "The input does not contain an audio stream to keep.",
    });
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
    ...(options.audio === undefined ? {} : { audio: options.audio }),
    ...(options.codecs === undefined ? {} : { codecs: options.codecs }),
    ...(options.crf === undefined ? {} : { crf: options.crf }),
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
