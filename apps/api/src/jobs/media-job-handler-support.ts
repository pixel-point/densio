import { JobResultSchema, type JobResult } from "@densio/shared";
import { Effect, Layer, Predicate, Schema } from "effect";

import { PLAN_ENTITLEMENTS } from "../auth/entitlements.ts";
import { MINIMUM_JOB_CREDIT_UNITS } from "../billing/credit-units.ts";
import type { Database } from "../database/database.ts";
import { MediaInspectionError } from "../media/inspection/media-inspection-error.ts";
import { MediaInspector } from "../media/inspection/media-inspector.ts";
import { MediaPlanError } from "../media/media-plan-error.ts";
import type { MediaProcessError } from "../media/process/media-process-runner.ts";
import { MediaProcessRunner } from "../media/process/media-process-runner.ts";
import { MediaWorkflowProcessError } from "../media/workflows/workflow-command.ts";
import type { WorkflowCommandDiagnostic } from "../media/workflows/workflow-types.ts";
import { makeJobStoragePaths } from "../storage/workspace.ts";
import { makeRecordingMediaProcessRunner, sanitizeMediaStderr } from "./job-command-recorder.ts";
import type { Job, JobAnalysis } from "./job-worker.ts";
import { JobProcessorError } from "./job-worker.ts";

export interface MediaJobAdapterConfig {
  readonly artifactTtlMs: number;
  readonly audioSilenceThresholdDb: number;
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  readonly maxExtractedImages: number;
  readonly mediaRoot: string;
  readonly publicBaseUrl: string;
}

export interface MediaJobHandlerContext {
  readonly config: MediaJobAdapterConfig;
  readonly database: Database;
  readonly runner: MediaProcessRunner["Service"];
}

export interface MediaJobHandler {
  readonly analyze: (job: Job) => Effect.Effect<JobAnalysis, unknown>;
  readonly process: (job: Job, analysis: Schema.Json) => Effect.Effect<Schema.Json, unknown>;
}

export const analysisIdentityFields = {
  attempt: Schema.Int,
  jobId: Schema.NonEmptyString,
  source: Schema.Struct({ height: Schema.Int, width: Schema.Int }),
};

export const positiveDurationSchema = Schema.Finite.check(Schema.isGreaterThan(0));

export const meteredAnalysis = (
  data: Schema.Json,
  creditUnits = MINIMUM_JOB_CREDIT_UNITS,
): JobAnalysis => ({ creditUnits, data });

const decodeJobResult = Schema.decodeUnknownEffect(JobResultSchema);

export const inspectJob = <Value, Error>(
  context: MediaJobHandlerContext,
  job: Job,
  inspect: (inspector: MediaInspector["Service"], inputFile: string) => Effect.Effect<Value, Error>,
) =>
  Effect.gen(function* () {
    const paths = yield* makeJobStoragePaths(context.config.mediaRoot, job.id);
    const recordingRunner = makeRecordingRunner(context, job);
    const inspectorLayer = MediaInspector.layer({
      ffmpegPath: context.config.ffmpegPath,
      ffprobePath: context.config.ffprobePath,
      silenceThresholdDb: context.config.audioSilenceThresholdDb,
    }).pipe(Layer.provide(Layer.succeed(MediaProcessRunner, recordingRunner)));
    return yield* MediaInspector.use((inspector) => inspect(inspector, paths.inputFile)).pipe(
      Effect.provide(inspectorLayer),
    );
  });

export const prepareJobExecution = Effect.fn("MediaJobHandler.prepare")(function* (
  context: MediaJobHandlerContext,
  job: Job,
) {
  return {
    paths: yield* makeJobStoragePaths(context.config.mediaRoot, job.id),
    recordingRunner: makeRecordingRunner(context, job),
  };
});

export const entitlementsFor = (job: Job) => PLAN_ENTITLEMENTS[job.plan];

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

export const sanitizeCommands = (commands: ReadonlyArray<WorkflowCommandDiagnostic>) =>
  commands.map((command) => ({
    ...command,
    ...(command.stderrTail === undefined
      ? {}
      : { stderrTail: sanitizeMediaStderr(command.stderrTail) }),
  }));

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

const invalidAnalysis = () =>
  new JobProcessorError({
    code: "STALE_JOB_ANALYSIS",
    details: {},
    message: "The media analysis does not belong to this job attempt.",
  });

const toProcessorError = (error: unknown) => {
  if (error instanceof JobProcessorError) return error;
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
