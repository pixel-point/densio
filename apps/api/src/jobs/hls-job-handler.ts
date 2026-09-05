import { randomUUID } from "node:crypto";
import { ResolvedHlsOptionsSchema, SourceInspectionSchema } from "@densio/shared";
import { Effect, Schema } from "effect";
import { compressionCreditUnits } from "../billing/compression-credit-cost.ts";
import { MediaProcessRunner } from "../media/process/media-process-runner.ts";
import { validateMediaEntitlements } from "../media/inspection/media-entitlement-check.ts";
import { runHlsWorkflow } from "../media/workflows/hls-workflow.ts";
import { validateHlsSource } from "../media/hls-policy.ts";
import { normalizeSourceInspection } from "../sources/source-inspection.ts";
import { publishAndRegisterArtifacts } from "./artifact-publication.ts";
import {
  analysisIdentityFields,
  assertCurrentAnalysis,
  decodeJobAnalysis,
  decodeJobOptions,
  entitlementsFor,
  inspectJob,
  meteredAnalysis,
  prepareJobExecution,
  validateJobResult,
  type MediaJobHandler,
  type MediaJobHandlerContext,
} from "./media-job-handler-support.ts";
import { JobProcessorError, type Job } from "./job-worker.ts";

const HlsAnalysisSchema = Schema.Struct({
  ...analysisIdentityFields,
  kind: Schema.Literal("hls"),
  inspection: SourceInspectionSchema,
  audioAnalysis: Schema.Literals(["absent", "silent", "audible"]),
});

export const makeHlsJobHandler = (
  context: MediaJobHandlerContext,
): MediaJobHandler<typeof HlsAnalysisSchema.Type> => ({
  analyze: (job) => analyze(context, job),
  process: (job, analysis) => process(context, job, analysis),
});

const analyze = Effect.fn("HlsJobHandler.analyze")(function* (
  context: MediaJobHandlerContext,
  job: Job,
) {
  const options = yield* decodeJobOptions(ResolvedHlsOptionsSchema, job.resolvedOptionsJson, "hls");
  const analysis = yield* inspectJob(context, job, (inspector, path) =>
    Effect.gen(function* () {
      const media = yield* inspector.inspect(path);
      const inspection = yield* normalizeSourceInspection(media);
      yield* validateMediaEntitlements(media, ["h265"], entitlementsFor(job));
      yield* validateHlsSource(inspection);
      if (options.audio === "keep" && options.audioStreamIndex === undefined)
        return yield* new JobProcessorError({
          code: "AUDIO_STREAM_REQUIRED",
          details: {},
          message: "The input does not contain audio to keep.",
        });
      const audioAnalysis =
        options.audio === "auto"
          ? yield* inspector.classifyAudio(
              path,
              options.audioStreamIndex === undefined ? [] : [options.audioStreamIndex],
            )
          : options.audioStreamIndex === undefined
            ? ("absent" as const)
            : ("audible" as const);
      return {
        attempt: job.attemptCount,
        jobId: job.id,
        kind: "hls" as const,
        source: media.displayDimensions,
        inspection,
        audioAnalysis,
      };
    }),
  );
  return meteredAnalysis(
    analysis,
    options.renditions.reduce(
      (sum, output) =>
        sum +
        compressionCreditUnits({
          codecCount: 1,
          durationSeconds: analysis.inspection.durationSeconds,
          source: analysis.source,
          output,
        }),
      0,
    ),
  );
});

const process = Effect.fn("HlsJobHandler.process")(function* (
  context: MediaJobHandlerContext,
  job: Job,
  input: typeof HlsAnalysisSchema.Type,
) {
  const analysis = yield* decodeJobAnalysis(HlsAnalysisSchema, input);
  assertCurrentAnalysis(job, analysis);
  const options = yield* decodeJobOptions(ResolvedHlsOptionsSchema, job.resolvedOptionsJson, "hls");
  const { paths, recordingRunner } = yield* prepareJobExecution(context, job);
  const workflow = yield* runHlsWorkflow({
    paths,
    options,
    source: analysis.inspection,
    audioAnalysis: analysis.audioAnalysis,
    packageId: randomUUID(),
    ...(context.config.hlsMaxScratchBytes === undefined
      ? {}
      : { maxScratchBytes: context.config.hlsMaxScratchBytes }),
    executable: context.config.ffmpegPath,
  }).pipe(Effect.provideService(MediaProcessRunner, recordingRunner));
  const published = yield* publishAndRegisterArtifacts(
    context.database,
    context.config,
    job,
    paths,
    workflow.outputs,
    workflow.package,
  );
  const archive = published[0];
  if (!archive)
    return yield* new JobProcessorError({
      code: "INVALID_JOB_RESULT",
      details: {},
      message: "HLS archive was not published.",
    });
  return yield* validateJobResult({
    kind: "hls",
    packageId: workflow.package.packageId,
    archiveArtifactId: archive.id,
    archiveBytes: archive.bytes,
    packageBytes: workflow.package.packageBytes,
    masterPlaylist: "master.m3u8",
    renditions: workflow.package.renditions,
  });
});
