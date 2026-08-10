import { randomUUID } from "node:crypto";

import {
  CompressionOptionsSchema,
  JobDecisionSchema,
  JobResultSchema,
  PLAN_CATALOG,
  type JobSource,
  type JobStatus,
  type JobWorkflow,
  type FrameRatePolicy,
  type Plan,
} from "@densio/shared";
import { Effect, Predicate, Schema } from "effect";

import type { Database } from "../database/database.ts";
import { findOwnedJob, requeueFrameRateDecision } from "../database/job-lifecycle-repository.ts";
import { createJob, requestJobCancellation } from "../database/job-repository.ts";
import { jobs } from "../database/schema.ts";
import { makeProblem, toProblemDetails } from "../errors/problem-details.ts";
import {
  cleanupJobWorkspace,
  makeJobStoragePaths,
  prepareJobWorkspace,
} from "../storage/workspace.ts";
import { tryJobRepository } from "./job-effect-support.ts";
import {
  JobComparisonDurationExceeded,
  JobCreditsExhausted,
  JobIdempotencyConflict,
  JobNotFound,
  JobRepositoryError,
  JobStateConflict,
  JobUploadLimitExceeded,
} from "./job-errors.ts";
import { makeJobUploadService } from "./job-upload-service.ts";

export {
  JobComparisonDurationExceeded,
  JobCreditsExhausted,
  JobIdempotencyConflict,
  JobNotFound,
  JobRepositoryError,
  JobStateConflict,
  JobUploadExpired,
  JobUploadLimitExceeded,
} from "./job-errors.ts";

interface JobServiceConfig {
  readonly maxComparisonSeconds: number;
  readonly maxUploadBytes: number;
  readonly mediaRoot: string;
  readonly publicBaseUrl: string;
  readonly uploadTtlMs: number;
}

interface CreateJobInput {
  readonly idempotencyKey?: string;
  readonly now: number;
  readonly options: Schema.Json;
  readonly plan: Plan;
  readonly source: JobSource;
  readonly userId: string;
  readonly workflow: JobWorkflow;
}

interface OwnedJobInput {
  readonly correlationId: string;
  readonly jobId: string;
  readonly userId: string;
}

interface FrameRateDecisionInput extends OwnedJobInput {
  readonly frameRate: FrameRatePolicy;
  readonly now: number;
}

export const makeJobService = (database: Database, config: JobServiceConfig) => {
  const uploads = makeJobUploadService(database, config);
  const create = Effect.fn("JobService.create")(function* (input: CreateJobInput) {
    const comparisonDuration =
      input.workflow === "compare-quality" &&
      Predicate.isObject(input.options) &&
      Predicate.isNumber(input.options.durationSeconds)
        ? input.options.durationSeconds
        : undefined;
    if (comparisonDuration !== undefined && comparisonDuration > config.maxComparisonSeconds) {
      return yield* new JobComparisonDurationExceeded({
        limitSeconds: config.maxComparisonSeconds,
      });
    }
    const planPolicy = PLAN_CATALOG[input.plan];
    const maxUploadBytes = Math.min(config.maxUploadBytes, planPolicy.maxUploadBytes);
    if (input.source.bytes > maxUploadBytes) {
      return yield* new JobUploadLimitExceeded({ limitBytes: maxUploadBytes });
    }

    const optionsJson = JSON.stringify(input.options);
    const jobId = randomUUID();
    const paths = yield* makeJobStoragePaths(config.mediaRoot, jobId);
    yield* prepareJobWorkspace(paths).pipe(
      Effect.tapError(() => ignoreCleanup(cleanupJobWorkspace(paths))),
    );
    const creation = yield* tryJobRepository("create", () =>
      createJob(
        database,
        {
          createdAt: input.now,
          declaredBytes: input.source.bytes,
          id: jobId,
          idempotencyKey: input.idempotencyKey,
          kind: input.workflow,
          maxUploadBytes,
          optionsJson,
          plan: input.plan,
          sourceFilename: input.source.filename,
          state: "awaiting-upload",
          updatedAt: input.now,
          userId: input.userId,
        },
        {
          creditPeriodStart: utcMonthStart(input.now),
          monthlyCredits: planPolicy.monthlyCredits,
        },
      ),
    ).pipe(Effect.tapError(() => ignoreCleanup(cleanupJobWorkspace(paths))));

    if ("availableCredits" in creation) {
      yield* cleanupJobWorkspace(paths);
      return yield* new JobCreditsExhausted({
        availableCredits: creation.availableCredits,
        monthlyCredits: planPolicy.monthlyCredits,
      });
    }

    if (!creation.created) {
      yield* cleanupJobWorkspace(paths);
      if (!matchesIdempotentRequest(creation.job, input, optionsJson)) {
        return yield* new JobIdempotencyConflict();
      }
    }
    return createdResponse(creation.job, config);
  });

  return {
    create,
    recoverUploads: uploads.maintain,
    upload: uploads.upload,
    ...makeOwnedJobOperations(database, config),
  };
};

const makeOwnedJobOperations = (database: Database, config: JobServiceConfig) => {
  const status = Effect.fn("JobService.status")(function* (input: OwnedJobInput) {
    const job = yield* tryJobRepository("find-status", () => findOwnedJob(database, input));
    if (job === undefined) return yield* new JobNotFound();
    return yield* toJobStatus(job, input.correlationId, config);
  });

  const decideFrameRate = Effect.fn("JobService.decideFrameRate")(function* (
    input: FrameRateDecisionInput,
  ) {
    const existing = yield* tryJobRepository("find-frame-rate-decision", () =>
      findOwnedJob(database, input),
    );
    if (existing === undefined) return yield* new JobNotFound();
    if (existing.kind !== "compress") {
      return yield* new JobStateConflict({ state: existing.state });
    }
    if (existing.state !== "awaiting-decision") {
      if (yield* matchesResolvedFrameRateDecision(existing, input.frameRate)) {
        return yield* toJobStatus(existing, input.correlationId, config);
      }
      return yield* new JobStateConflict({ state: existing.state });
    }
    yield* decodeStoredDecision(existing.decisionJson);
    const options = yield* decodeStoredCompressionOptions(existing.optionsJson);
    const updated = yield* tryJobRepository("submit-frame-rate-decision", () =>
      requeueFrameRateDecision(database, {
        jobId: input.jobId,
        now: input.now,
        optionsJson: JSON.stringify({ ...options, frameRate: input.frameRate }),
        userId: input.userId,
      }),
    );
    if (updated !== undefined) return yield* toJobStatus(updated, input.correlationId, config);

    const current = yield* tryJobRepository("refetch-frame-rate-decision", () =>
      findOwnedJob(database, input),
    );
    if (current === undefined) return yield* new JobNotFound();
    if (yield* matchesResolvedFrameRateDecision(current, input.frameRate)) {
      return yield* toJobStatus(current, input.correlationId, config);
    }
    return yield* new JobStateConflict({ state: current.state });
  });

  const cancel = Effect.fn("JobService.cancel")(function* (
    input: OwnedJobInput & { readonly now: number },
  ) {
    const existing = yield* tryJobRepository("find-cancel", () => findOwnedJob(database, input));
    if (existing === undefined) return yield* new JobNotFound();
    const job = yield* tryJobRepository("cancel", () =>
      requestJobCancellation(database, input.jobId, input.userId, input.now),
    );
    if (job === undefined) return yield* new JobNotFound();
    if (job.state === "canceled") {
      const paths = yield* makeJobStoragePaths(config.mediaRoot, job.id);
      yield* cleanupJobWorkspace(paths);
    }
    return yield* toJobStatus(job, input.correlationId, config);
  });

  return { cancel, decideFrameRate, status };
};

const toJobStatus = Effect.fn("JobService.toStatus")(function* (
  job: typeof jobs.$inferSelect,
  correlationId: string,
  config: JobServiceConfig,
) {
  const base = {
    createdAt: new Date(job.createdAt).toISOString(),
    id: job.id,
    plan: job.plan,
    updatedAt: new Date(job.updatedAt).toISOString(),
    workflow: job.kind,
  };
  if (job.state === "succeeded") {
    return {
      ...base,
      progressPercent: 100 as const,
      result: yield* decodeStoredResult(job.resultJson),
      state: "succeeded" as const,
    } satisfies JobStatus;
  }
  if (job.state === "failed") {
    return {
      ...base,
      problem: toFailedProblem(job, correlationId),
      progressPercent: job.progress,
      state: "failed" as const,
    } satisfies JobStatus;
  }
  if (job.state === "expired") {
    return {
      ...base,
      progressPercent: 100 as const,
      state: "expired" as const,
    } satisfies JobStatus;
  }
  if (job.state === "awaiting-decision") {
    return {
      ...base,
      decision: {
        ...(yield* decodeStoredDecision(job.decisionJson)),
        submitUrl: new URL(
          `/v1/jobs/${job.id}/frame-rate-decision`,
          config.publicBaseUrl,
        ).toString(),
      },
      progressPercent: 5 as const,
      state: "awaiting-decision" as const,
    } satisfies JobStatus;
  }
  return {
    ...base,
    progressPercent: job.progress,
    state: job.state,
  } satisfies JobStatus;
});

const decodeStoredCompressionOptions = (value: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(CompressionOptionsSchema))(value).pipe(
    Effect.mapError(
      (cause) => new JobRepositoryError({ cause, operation: "decode-compression-options" }),
    ),
  );

const decodeStoredDecision = (value: string | null) => {
  if (value === null) {
    return Effect.fail(
      new JobRepositoryError({ cause: "missing-decision", operation: "decode-decision" }),
    );
  }
  return Schema.decodeUnknownEffect(Schema.fromJsonString(JobDecisionSchema))(value).pipe(
    Effect.mapError((cause) => new JobRepositoryError({ cause, operation: "decode-decision" })),
  );
};

const matchesResolvedFrameRateDecision = Effect.fn("JobService.matchesResolvedFrameRateDecision")(
  function* (job: typeof jobs.$inferSelect, frameRate: FrameRatePolicy) {
    if (job.decisionJson === null) return false;
    yield* decodeStoredDecision(job.decisionJson);
    const options = yield* decodeStoredCompressionOptions(job.optionsJson);
    return sameFrameRatePolicy(options.frameRate, frameRate);
  },
);

const sameFrameRatePolicy = (left: FrameRatePolicy | undefined, right: FrameRatePolicy) =>
  left?.mode === right.mode &&
  (left.mode !== "cap" || (right.mode === "cap" && left.maximum === right.maximum));

const decodeStoredResult = Effect.fn("JobService.decodeResult")(function* (value: string | null) {
  if (value === null) {
    return yield* new JobRepositoryError({ cause: "missing-result", operation: "decode-result" });
  }
  const parsed = yield* Effect.try({
    catch: (cause) => new JobRepositoryError({ cause, operation: "decode-result" }),
    try: (): unknown => JSON.parse(value),
  });
  return yield* Schema.decodeUnknownEffect(JobResultSchema)(parsed).pipe(
    Effect.mapError((cause) => new JobRepositoryError({ cause, operation: "decode-result" })),
  );
});

const toFailedProblem = (job: typeof jobs.$inferSelect, correlationId: string) => {
  const problem =
    job.errorCode === "CREDITS_EXHAUSTED"
      ? makeProblem({
          code: "CREDITS_EXHAUSTED",
          detail: "The analyzed job cost exceeds the account's available monthly credits.",
          jobId: job.id,
          retryable: false,
          status: 402,
          suggestedAction: "Wait for the monthly reset or upgrade the account plan.",
          title: "Credits exhausted",
        })
      : makeProblem({
          code:
            job.errorCode !== null && /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(job.errorCode)
              ? job.errorCode
              : "JOB_FAILED",
          detail: "The media job could not be completed.",
          jobId: job.id,
          retryable: false,
          status: 422,
          suggestedAction: "Check the source media and options, then create a new job.",
          title: "Media job failed",
        });
  return toProblemDetails(problem, correlationId);
};

const createdResponse = (job: typeof jobs.$inferSelect, config: JobServiceConfig) => ({
  jobId: job.id,
  state: "awaiting-upload" as const,
  statusUrl: new URL(`/v1/jobs/${job.id}`, config.publicBaseUrl).toString(),
  upload: {
    expiresAt: new Date(job.createdAt + config.uploadTtlMs).toISOString(),
    method: "PUT" as const,
    url: new URL(`/v1/jobs/${job.id}/upload`, config.publicBaseUrl).toString(),
  },
});

const matchesIdempotentRequest = (
  job: typeof jobs.$inferSelect,
  input: CreateJobInput,
  optionsJson: string,
) =>
  job.kind === input.workflow &&
  job.declaredBytes === input.source.bytes &&
  job.sourceFilename === input.source.filename &&
  job.optionsJson === optionsJson;

const ignoreCleanup = (cleanup: Effect.Effect<void, unknown>) =>
  cleanup.pipe(Effect.catch(() => Effect.void));

const utcMonthStart = (timestamp: number) => {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
};
