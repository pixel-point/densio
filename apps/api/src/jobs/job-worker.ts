import { randomUUID } from "node:crypto";

import { Clock, Context, Deferred, Effect, Fiber, Ref, Schema, type Scope } from "effect";

import type { Database } from "../database/database.ts";
import {
  claimNextJob,
  findJobsByIds,
  isJobCancellationRequested,
  recoverExpiredJobs,
} from "../database/job-repository.ts";
import { transitionJob } from "../database/job-transition-repository.ts";
import { isTerminalJob, type JobTransitionCommand } from "./job-transition.ts";
import { jobs } from "../database/schema.ts";
import { withJobWriteActivity } from "./job-write-activity.ts";

export type Job = typeof jobs.$inferSelect;

export class JobProcessorError extends Schema.TaggedErrorClass<JobProcessorError>()(
  "JobProcessorError",
  {
    code: Schema.NonEmptyString,
    details: Schema.Json,
    message: Schema.NonEmptyString,
  },
) {}

class JobCanceled extends Schema.TaggedErrorClass<JobCanceled>()("JobCanceled", {}) {}

class JobLeaseLost extends Schema.TaggedErrorClass<JobLeaseLost>()("JobLeaseLost", {}) {}

export interface ReadyJobAnalysis {
  readonly kind: "ready";
  readonly creditUnits: number;
  readonly process: (job: Job) => Effect.Effect<Schema.Json, JobProcessorError>;
}

export type JobAnalysis = ReadyJobAnalysis;

export class JobProcessor extends Context.Service<
  JobProcessor,
  {
    analyze(job: Job): Effect.Effect<JobAnalysis, JobProcessorError>;
  }
>()("densio/jobs/JobProcessor") {}

export class JobCleanup extends Context.Service<
  JobCleanup,
  { cleanup(job: Job): Effect.Effect<void> }
>()("densio/jobs/JobCleanup") {}

export interface JobWorkerOptions {
  readonly concurrency: number;
  readonly heartbeatIntervalMs: number;
  readonly leaseDurationMs: number;
  readonly maxAttempts: number;
  readonly pollIntervalMs: number;
  readonly workerId: string;
}

export interface JobWorker {
  readonly stop: () => Effect.Effect<void>;
}

export const startJobWorker = Effect.fn("JobWorker.start")(function* (
  database: Database,
  options: JobWorkerOptions,
): Effect.fn.Return<JobWorker, never, JobCleanup | JobProcessor | Scope.Scope> {
  const cleanup = yield* JobCleanup;
  const processor = yield* JobProcessor;
  const now = yield* Clock.currentTimeMillis;
  const recovery = recoverExpiredJobs(database, { maxAttempts: options.maxAttempts, now });
  const recoveredTerminalJobs = findJobsByIds(database, [...recovery.failed, ...recovery.canceled]);
  yield* Effect.forEach(recoveredTerminalJobs, cleanup.cleanup);
  const stopping = yield* Ref.make(false);
  const stopSignal = yield* Deferred.make<void>();
  const workerRunId = `${options.workerId}-${randomUUID()}`;
  const fibers = yield* Effect.forEach(
    Array.from({ length: options.concurrency }, (_, index) => index),
    (index) =>
      runWorkerSlot(
        database,
        options,
        processor,
        cleanup,
        stopping,
        stopSignal,
        workerRunId,
        index,
      ).pipe(Effect.forkScoped({ startImmediately: true })),
  );
  const stop = Effect.fn("JobWorker.stop")(function* () {
    yield* Ref.set(stopping, true);
    yield* Deferred.succeed(stopSignal, undefined);
    yield* Effect.forEach(fibers, Fiber.join, { concurrency: "unbounded" });
  });

  return { stop };
});

const runWorkerSlot = Effect.fn("JobWorker.runSlot")(function* (
  database: Database,
  options: JobWorkerOptions,
  processor: JobProcessor["Service"],
  cleanup: JobCleanup["Service"],
  stopping: Ref.Ref<boolean>,
  stopSignal: Deferred.Deferred<void>,
  workerRunId: string,
  slot: number,
) {
  const workerId = `${workerRunId}-${slot}`;
  while (!(yield* Ref.get(stopping))) {
    const now = yield* Clock.currentTimeMillis;
    const job = claimNextJob(database, {
      leaseDurationMs: options.leaseDurationMs,
      now,
      workerId,
    });
    if (job !== undefined) {
      yield* runClaimedJob(database, options, processor, cleanup, job, workerId);
      continue;
    }
    const recovered = recoverExpiredJobs(database, { maxAttempts: options.maxAttempts, now });
    yield* Effect.forEach(
      findJobsByIds(database, [...recovered.failed, ...recovered.canceled]),
      cleanup.cleanup,
    );
    yield* Effect.raceFirst(Effect.sleep(options.pollIntervalMs), Deferred.await(stopSignal));
  }
});

const runClaimedJob = Effect.fn("JobWorker.runClaimedJob")(function* (
  database: Database,
  options: JobWorkerOptions,
  processor: JobProcessor["Service"],
  cleanup: JobCleanup["Service"],
  job: Job,
  workerId: string,
) {
  const execution = Effect.catchDefect(
    Effect.raceFirst(
      executeClaimedJob(database, options, processor, job, workerId),
      monitorClaim(database, options, job, workerId),
    ),
    () =>
      Effect.fail(
        new JobProcessorError({
          code: "JOB_PROCESSOR_DEFECT",
          details: {},
          message: "The job processor terminated unexpectedly.",
        }),
      ),
  );
  yield* withJobWriteActivity(
    database,
    job,
    Effect.catchTags(execution, {
      JobCanceled: () => persistCancellation(database, job, workerId),
      JobLeaseLost: () => Effect.void,
      JobProcessorError: (error) => persistFailure(database, job, workerId, error),
    }),
  );
  const current = findJobsByIds(database, [job.id])[0];
  if (current !== undefined && isTerminalJob(current.state)) yield* cleanup.cleanup(current);
});

const executeClaimedJob = Effect.fn("JobWorker.executeClaimedJob")(function* (
  database: Database,
  options: JobWorkerOptions,
  processor: JobProcessor["Service"],
  job: Job,
  workerId: string,
) {
  const analysis = yield* processor.analyze(job);
  if (analysis.creditUnits !== job.quoteCreditUnits) {
    return yield* new JobProcessorError({
      code: "PLAN_DIVERGED",
      details: {
        analyzedCreditUnits: analysis.creditUnits,
        quotedCreditUnits: job.quoteCreditUnits,
      },
      message: "Trusted job analysis no longer matches the immutable execution plan quote.",
    });
  }
  const processingAt = yield* Clock.currentTimeMillis;
  const processing = transitionJob(database, {
    jobId: job.id,
    now: processingAt,
    command: {
      type: "processing",
      attempt: job.attemptCount,
      workerId,
      creditUnits: analysis.creditUnits,
      leaseDurationMs: options.leaseDurationMs,
    },
  });
  if (processing === undefined) return yield* claimUnavailable(database, job, workerId);
  if (processing.state === "failed") {
    return;
  }

  const result = yield* analysis.process(processing);
  const completedAt = yield* Clock.currentTimeMillis;
  const completed = transitionJob(database, {
    jobId: job.id,
    now: completedAt,
    command: {
      type: "complete",
      attempt: job.attemptCount,
      workerId,
      resultJson: JSON.stringify(result),
    },
  });
  if (completed === undefined) return yield* claimUnavailable(database, job, workerId);
});

const monitorClaim = Effect.fn("JobWorker.monitorClaim")(function* (
  database: Database,
  options: JobWorkerOptions,
  job: Job,
  workerId: string,
) {
  while (true) {
    yield* Effect.sleep(options.heartbeatIntervalMs);
    if (isJobCancellationRequested(database, job.id, workerId, job.attemptCount)) {
      return yield* new JobCanceled();
    }
    const now = yield* Clock.currentTimeMillis;
    const renewed = transitionJob(database, {
      jobId: job.id,
      now,
      command: {
        type: "lease",
        attempt: job.attemptCount,
        workerId,
        leaseDurationMs: options.leaseDurationMs,
      },
    });
    if (renewed === undefined) return yield* new JobLeaseLost();
  }
});

const claimUnavailable = (
  database: Database,
  job: Job,
  workerId: string,
): Effect.Effect<never, JobCanceled | JobLeaseLost> =>
  isJobCancellationRequested(database, job.id, workerId, job.attemptCount)
    ? new JobCanceled()
    : new JobLeaseLost();

const persistFailure = Effect.fn("JobWorker.persistFailure")(function* (
  database: Database,
  job: Job,
  workerId: string,
  error: JobProcessorError,
) {
  if (isJobCancellationRequested(database, job.id, workerId, job.attemptCount)) {
    return yield* persistCancellation(database, job, workerId);
  }
  const now = yield* Clock.currentTimeMillis;
  const failed = transitionJob(database, {
    jobId: job.id,
    now,
    command: failureCommand(job, workerId, error),
  });
  if (failed === undefined) return;
});

const persistCancellation = Effect.fn("JobWorker.persistCancellation")(function* (
  database: Database,
  job: Job,
  workerId: string,
) {
  const now = yield* Clock.currentTimeMillis;
  const canceled = transitionJob(database, {
    jobId: job.id,
    now,
    command: { type: "confirm-canceled", workerId, attempt: job.attemptCount },
  });
  if (canceled === undefined) return;
});

const failureCommand = (
  job: Job,
  workerId: string,
  error: JobProcessorError,
): JobTransitionCommand => {
  const fence = { workerId, attempt: job.attemptCount };
  if (error.code === "OUTPUT_SIZE_LIMIT_EXCEEDED") {
    const details = Schema.decodeUnknownSync(
      Schema.Struct({ actualBytes: Schema.Int, limitBytes: Schema.Int }),
    )(error.details);
    return { type: "output-limit-exceeded", ...fence, ...details };
  }
  return {
    type: "fail",
    ...fence,
    code: error.code,
    details: error.details,
    message: error.message,
  };
};
