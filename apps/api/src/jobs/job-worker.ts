import { Clock, Context, Deferred, Effect, Fiber, Ref, Schema, type Scope } from "effect";

import type { Database } from "../database/database.ts";
import {
  cancelClaimedJob,
  claimNextJob,
  completeJob,
  failJob,
  findJobsByIds,
  isJobCancellationRequested,
  markJobProcessing,
  recoverExpiredJobs,
  renewJobLease,
} from "../database/job-repository.ts";
import { jobs } from "../database/schema.ts";

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

export class JobProcessor extends Context.Service<
  JobProcessor,
  {
    analyze(job: Job): Effect.Effect<Schema.Json, JobProcessorError>;
    process(job: Job, analysis: Schema.Json): Effect.Effect<Schema.Json, JobProcessorError>;
  }
>()("ffmpeg-api/jobs/JobProcessor") {}

export class JobCleanup extends Context.Service<
  JobCleanup,
  { cleanup(job: Job): Effect.Effect<void> }
>()("ffmpeg-api/jobs/JobCleanup") {}

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
  const fibers = yield* Effect.forEach(
    Array.from({ length: options.concurrency }, (_, index) => index),
    (index) =>
      runWorkerSlot(database, options, processor, cleanup, stopping, stopSignal, index).pipe(
        Effect.forkScoped({ startImmediately: true }),
      ),
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
  slot: number,
) {
  while (!(yield* Ref.get(stopping))) {
    const now = yield* Clock.currentTimeMillis;
    const workerId = `${options.workerId}-${slot}`;
    const job = claimNextJob(database, {
      leaseDurationMs: options.leaseDurationMs,
      now,
      workerId,
    });
    if (job !== undefined) {
      yield* runClaimedJob(database, options, processor, cleanup, job, workerId);
      continue;
    }
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
      executeClaimedJob(database, options, processor, cleanup, job, workerId),
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
  yield* Effect.catchTags(execution, {
    JobCanceled: () => persistCancellation(database, cleanup, job, workerId),
    JobLeaseLost: () => Effect.void,
    JobProcessorError: (error) => persistFailure(database, cleanup, job, workerId, error),
  });
});

const executeClaimedJob = Effect.fn("JobWorker.executeClaimedJob")(function* (
  database: Database,
  options: JobWorkerOptions,
  processor: JobProcessor["Service"],
  cleanup: JobCleanup["Service"],
  job: Job,
  workerId: string,
) {
  const analysis = yield* processor.analyze(job);
  const processingAt = yield* Clock.currentTimeMillis;
  const processing = markJobProcessing(database, {
    jobId: job.id,
    leaseDurationMs: options.leaseDurationMs,
    now: processingAt,
    workerId,
  });
  if (processing === undefined) return yield* claimUnavailable(database, job, workerId);

  const result = yield* processor.process(processing, analysis);
  const completedAt = yield* Clock.currentTimeMillis;
  const completed = completeJob(database, {
    jobId: job.id,
    now: completedAt,
    resultJson: JSON.stringify(result),
    workerId,
  });
  if (completed === undefined) return yield* claimUnavailable(database, job, workerId);
  yield* cleanup.cleanup(completed);
});

const monitorClaim = Effect.fn("JobWorker.monitorClaim")(function* (
  database: Database,
  options: JobWorkerOptions,
  job: Job,
  workerId: string,
) {
  while (true) {
    yield* Effect.sleep(options.heartbeatIntervalMs);
    if (isJobCancellationRequested(database, job.id, workerId)) {
      return yield* new JobCanceled();
    }
    const now = yield* Clock.currentTimeMillis;
    const renewed = renewJobLease(database, {
      jobId: job.id,
      leaseDurationMs: options.leaseDurationMs,
      now,
      workerId,
    });
    if (renewed === undefined) return yield* new JobLeaseLost();
  }
});

const claimUnavailable = (
  database: Database,
  job: Job,
  workerId: string,
): Effect.Effect<never, JobCanceled | JobLeaseLost> =>
  isJobCancellationRequested(database, job.id, workerId) ? new JobCanceled() : new JobLeaseLost();

const persistFailure = Effect.fn("JobWorker.persistFailure")(function* (
  database: Database,
  cleanup: JobCleanup["Service"],
  job: Job,
  workerId: string,
  error: JobProcessorError,
) {
  if (isJobCancellationRequested(database, job.id, workerId)) {
    return yield* persistCancellation(database, cleanup, job, workerId);
  }
  const now = yield* Clock.currentTimeMillis;
  const failed = failJob(database, {
    errorCode: error.code,
    errorJson: JSON.stringify({ message: error.message, details: error.details }),
    jobId: job.id,
    now,
    workerId,
  });
  if (failed === undefined) return;
  yield* cleanup.cleanup(failed);
});

const persistCancellation = Effect.fn("JobWorker.persistCancellation")(function* (
  database: Database,
  cleanup: JobCleanup["Service"],
  job: Job,
  workerId: string,
) {
  const now = yield* Clock.currentTimeMillis;
  const canceled = cancelClaimedJob(database, { jobId: job.id, now, workerId });
  if (canceled === undefined) return;
  yield* cleanup.cleanup(canceled);
});
