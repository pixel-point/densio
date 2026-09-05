import { JobResultSchema, SourceInspectionSchema, type JobResult } from "@densio/shared";
import { Clock, Effect, Layer, Predicate, Schema } from "effect";

import { PLAN_ENTITLEMENTS } from "../auth/entitlements.ts";
import { MINIMUM_JOB_CREDIT_UNITS } from "../billing/credit-units.ts";
import type { Database } from "../database/database.ts";
import { transitionJob } from "../database/job-transition-repository.ts";
import { matchesPlannedInspection } from "../sources/source-inspection-compatibility.ts";
import { normalizeSourceInspection } from "../sources/source-inspection.ts";
import { MediaInspectionError } from "../media/inspection/media-inspection-error.ts";
import { MediaInspector } from "../media/inspection/media-inspector.ts";
import type { MediaProbe } from "../media/inspection/media-probe.ts";
import { MediaPlanError } from "../media/media-plan-error.ts";
import type { MediaProcessError } from "../media/process/media-process-runner.ts";
import { MediaProcessRunner } from "../media/process/media-process-runner.ts";
import { MediaWorkflowProcessError } from "../media/workflows/workflow-command.ts";
import { HlsScratchLimitExceeded } from "../media/workflows/hls-scratch.ts";
import { makeJobStoragePaths } from "../storage/workspace.ts";
import { makeRecordingMediaProcessRunner, sanitizeMediaStderr } from "./job-command-recorder.ts";
import { ArtifactOutputSizeLimitExceeded } from "./artifact-publication.ts";
import type { Job } from "./job-worker.ts";
import { JobProcessorError } from "./job-worker.ts";

export interface MediaJobAdapterConfig {
  readonly hlsMaxScratchBytes?: number;
  readonly artifactAccessGrantTtlMs: number;
  readonly artifactTtlMs: number;
  readonly audioSilenceThresholdDb: number;
  readonly ffmpegPath: string;
  readonly ffmpegVersion: string;
  readonly ffprobePath: string;
  readonly ffprobeVersion: string;
  readonly maxExtractedImages: number;
  readonly mediaRoot: string;
  readonly publicBaseUrl: string;
}

export interface MediaJobHandlerContext {
  readonly config: MediaJobAdapterConfig;
  readonly database: Database;
  readonly runner: MediaProcessRunner["Service"];
}

export interface MediaJobHandler<Analysis> {
  readonly analyze: (
    job: Job,
  ) => Effect.Effect<
    { readonly creditUnits: number; readonly data: Analysis; readonly kind: "ready" },
    unknown
  >;
  readonly process: (job: Job, analysis: Analysis) => Effect.Effect<Schema.Json, unknown>;
}

export const analysisIdentityFields = {
  attempt: Schema.Int,
  jobId: Schema.NonEmptyString,
  source: Schema.Struct({ height: Schema.Int, width: Schema.Int }),
};

export const positiveDurationSchema = Schema.Finite.check(Schema.isGreaterThan(0));

export const meteredAnalysis = <Analysis>(
  data: Analysis,
  creditUnits = MINIMUM_JOB_CREDIT_UNITS,
) => ({ creditUnits, data, kind: "ready" as const });

const decodeJobResult = Schema.decodeUnknownEffect(JobResultSchema);

export const inspectJob = <Value, Error>(
  context: MediaJobHandlerContext,
  job: Job,
  inspect: (inspector: JobMediaInspector, inputFile: string) => Effect.Effect<Value, Error>,
) =>
  Effect.gen(function* () {
    const paths = yield* makeJobStoragePaths(context.config.mediaRoot, job.id);
    const recordingRunner = makeRecordingRunner(context, job);
    const inspectorLayer = MediaInspector.layer({
      ffmpegPath: context.config.ffmpegPath,
      ffprobePath: context.config.ffprobePath,
      silenceThresholdDb: context.config.audioSilenceThresholdDb,
    }).pipe(Layer.provide(Layer.succeed(MediaProcessRunner, recordingRunner)));
    return yield* MediaInspector.use((inspector) =>
      inspect(recordingInspector(context, job, inspector), paths.inputFile),
    ).pipe(Effect.provide(inspectorLayer));
  });

export const prepareJobExecution = Effect.fn("MediaJobHandler.prepare")(function* (
  context: MediaJobHandlerContext,
  job: Job,
) {
  return {
    paths: yield* makeJobStoragePaths(context.config.mediaRoot, job.id, job.attemptCount),
    recordingRunner: makeRecordingRunner(context, job),
  };
});

export const entitlementsFor = (job: Job) => PLAN_ENTITLEMENTS[job.subscriptionPlan];

export const assertCurrentAnalysis = (
  job: Job,
  analysis: { readonly attempt: number; readonly jobId: string; readonly kind: string },
) => {
  if (
    analysis.jobId !== job.id ||
    analysis.attempt !== job.attemptCount ||
    analysis.kind !== job.kind
  ) {
    throw invalidAnalysis();
  }
};

export const decodeJobOptions = <S extends Schema.Top>(
  schema: S,
  optionsJson: string,
  workflow: string,
) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(optionsJson).pipe(
    Effect.mapError(
      () =>
        new JobProcessorError({
          code: "INVALID_JOB_OPTIONS",
          details: {},
          message: `The persisted ${workflow} options are invalid.`,
        }),
    ),
  );

export const decodeJobAnalysis = <S extends Schema.Top>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(Effect.mapError(invalidAnalysis));

export const validateJobResult = (result: JobResult) =>
  decodeJobResult(result).pipe(Effect.mapError(invalidJobResult));

export const invalidJobResult = () =>
  new JobProcessorError({
    code: "INVALID_JOB_RESULT",
    details: {},
    message: "The media workflow produced an invalid result.",
  });

export const adaptMediaJobErrors = <Value, Error, Requirements>(
  effect: Effect.Effect<Value, Error, Requirements>,
): Effect.Effect<Value, JobProcessorError, Requirements> =>
  effect.pipe(
    Effect.mapError(toProcessorError),
    Effect.catchDefect((defect) => Effect.fail(toDefectError(defect))),
  );

const makeRecordingRunner = (context: MediaJobHandlerContext, job: Job) =>
  makeRecordingMediaProcessRunner(
    context.database,
    job,
    context.runner,
    context.config.ffprobePath,
  );

export type JobMediaInspector = ReturnType<typeof recordingInspector>;

const recordingInspector = (
  context: MediaJobHandlerContext,
  job: Job,
  inspector: MediaInspector["Service"],
) => ({
  checkCapabilities: inspector.checkCapabilities,
  classifyAudio: inspector.classifyAudio,
  inspect: (inputPath: string) =>
    recordToolchain(context, job).pipe(
      Effect.andThen(inspector.inspect(inputPath)),
      Effect.tap((probe) => persistInspection(job, probe)),
    ),
  resolveFrameTimestamp: inspector.resolveFrameTimestamp,
});

const persistInspection = Effect.fn("MediaJobHandler.verifyInspection")(function* (
  job: Job,
  probe: MediaProbe,
) {
  const inspection = yield* normalizeSourceInspection(probe);
  const planned = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SourceInspectionSchema))(
    job.inspectionJson,
  ).pipe(Effect.mapError(() => invalidAnalysis()));
  if (!matchesPlannedInspection(planned, inspection)) {
    return yield* new JobProcessorError({
      code: "PLAN_DIVERGED",
      details: {},
      message: "Fresh source inspection differs from the immutable plan.",
    });
  }
});

const recordToolchain = Effect.fn("MediaJobHandler.recordToolchain")(function* (
  context: MediaJobHandlerContext,
  job: Job,
) {
  const now = yield* Clock.currentTimeMillis;
  const recorded = transitionJob(context.database, {
    jobId: job.id,
    now,
    command: {
      type: "provenance",
      attempt: job.attemptCount,
      workerId: job.leaseOwner ?? "",
      toolchainJson: JSON.stringify({
        ffmpegVersion: context.config.ffmpegVersion,
        ffprobeVersion: context.config.ffprobeVersion,
      }),
    },
  });
  if (recorded === undefined) return yield* invalidAnalysis();
});

const invalidAnalysis = () =>
  new JobProcessorError({
    code: "STALE_JOB_ANALYSIS",
    details: {},
    message: "The media analysis does not belong to this job attempt.",
  });

const toProcessorError = (error: unknown) => {
  if (error instanceof JobProcessorError) return error;
  if (error instanceof HlsScratchLimitExceeded)
    return new JobProcessorError({
      code: "HLS_SCRATCH_LIMIT_EXCEEDED",
      details: { actualBytes: error.actualBytes, limitBytes: error.limitBytes },
      message:
        "HLS exceeded its scratch budget or the media filesystem has less than 64 MiB free. Increase HLS_MAX_SCRATCH_BYTES or free disk space before retrying.",
    });
  if (error instanceof ArtifactOutputSizeLimitExceeded) {
    return new JobProcessorError({
      code: "OUTPUT_SIZE_LIMIT_EXCEEDED",
      details: { actualBytes: error.actualBytes, limitBytes: error.limitBytes },
      message: "The encoded outputs exceed the configured byte limit.",
    });
  }
  if (error instanceof MediaInspectionError) {
    return new JobProcessorError({
      code: error.reason.replaceAll("-", "_").toUpperCase(),
      details: {},
      message: error.message,
    });
  }
  if (error instanceof MediaWorkflowProcessError) {
    return new JobProcessorError({
      code: "MEDIA_PROCESS_FAILED",
      details: {
        arguments: [...error.failedCommand.arguments],
        executable: error.failedCommand.executable,
        exitCode: error.exitCode,
        stderrTail: sanitizeMediaStderr(error.stderrTail),
      },
      message: error.message,
    });
  }
  if (isMediaProcessError(error)) {
    return new JobProcessorError({
      code: "MEDIA_PROCESS_FAILED",
      details: {
        executable: error.executable,
        exitCode: error.exitCode,
        stderrTail: sanitizeMediaStderr(error.stderrTail),
      },
      message: error.message,
    });
  }
  return new JobProcessorError({
    code: "MEDIA_JOB_FAILED",
    details: {},
    message: Predicate.isError(error) ? error.message : "The media job failed.",
  });
};

const toDefectError = (defect: unknown) => {
  if (defect instanceof JobProcessorError) return defect;
  if (defect instanceof MediaPlanError) {
    return new JobProcessorError({ code: defect.code, details: {}, message: defect.message });
  }
  return new JobProcessorError({
    code: "MEDIA_JOB_DEFECT",
    details: {},
    message: "The media job terminated unexpectedly.",
  });
};

const isMediaProcessError = (error: unknown): error is MediaProcessError =>
  Predicate.isObject(error) && "reason" in error && "executable" in error && "stderrTail" in error;
