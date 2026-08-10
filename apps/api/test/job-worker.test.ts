import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, expect, it } from "vitest";

import { migrateDatabase, openDatabase, type Database } from "../src/database/database.ts";
import {
  claimNextJob,
  completeJob,
  createJob,
  requestJobCancellation,
  reserveJobCreditsAndMarkProcessing,
} from "../src/database/job-repository.ts";
import { jobs, users } from "../src/database/schema.ts";
import {
  JobCleanup,
  JobProcessor,
  JobProcessorError,
  startJobWorker,
  type Job,
  type JobWorkerOptions,
} from "../src/jobs/job-worker.ts";

const temporaryDirectories: Array<string> = [];
const workerOptions: JobWorkerOptions = {
  concurrency: 1,
  heartbeatIntervalMs: 20,
  leaseDurationMs: 100,
  maxAttempts: 2,
  pollIntervalMs: 10,
  workerId: "worker-test",
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

it("fails before processing when the analyzed cost exceeds available credits", async () => {
  const database = await createTestDatabase();
  createJob(database, jobValues("spent", 10), { creditPeriodStart: 0, monthlyCredits: 30 });
  claimNextJob(database, { leaseDurationMs: 100, now: 20, workerId: "setup-worker" });
  reserveJobCreditsAndMarkProcessing(database, {
    creditUnits: 2_995,
    jobId: "spent",
    leaseDurationMs: 100,
    monthlyCreditUnits: 3_000,
    now: 30,
    workerId: "setup-worker",
  });
  completeJob(database, {
    jobId: "spent",
    now: 40,
    resultJson: '{"kind":"compress"}',
    workerId: "setup-worker",
  });
  createJob(database, jobValues("target", 50), { creditPeriodStart: 0, monthlyCredits: 30 });
  const state = { processed: false };
  const processor = JobProcessor.of({
    analyze: () => Effect.succeed({ creditUnits: 10, data: null, kind: "ready" }),
    process: () => Effect.sync(() => (state.processed = true)),
  });
  const cleanup = JobCleanup.of({ cleanup: () => Effect.void });

  await runWorkerTest(
    Effect.scoped(
      Effect.gen(function* () {
        const worker = yield* startJobWorker(database, workerOptions);
        yield* waitUntil(() => readState(database, "target") === "failed");
        yield* worker.stop();
      }),
    ),
    cleanup,
    processor,
  );

  expect(state.processed).toBe(false);
  expect(database.db.select().from(jobs).where(eq(jobs.id, "target")).get()).toMatchObject({
    errorCode: "CREDITS_EXHAUSTED",
    state: "failed",
  });
  database.close();
});

it("claims oldest-first and transitions analyze to processing to success", async () => {
  const database = await createTestDatabase();
  insertJobs(database, [jobValues("job-newer", 20), jobValues("job-older", 10)]);
  const events: Array<string> = [];
  const processor = JobProcessor.of({
    analyze: (job) =>
      Effect.sync(() => {
        events.push(`${job.id}:analyze:${readState(database, job.id)}`);
        return metered({ sourceJobId: job.id });
      }),
    process: (job, analysis) =>
      Effect.sync(() => {
        expect(analysis).toEqual({ sourceJobId: job.id });
        events.push(`${job.id}:process:${readState(database, job.id)}`);
        return { jobId: job.id };
      }),
  });
  const cleanup = JobCleanup.of({
    cleanup: (job) => Effect.sync(() => events.push(`${job.id}:cleanup`)),
  });

  await runWorkerTest(
    Effect.scoped(
      Effect.gen(function* () {
        const worker = yield* startJobWorker(database, workerOptions);
        yield* waitUntil(() => readState(database, "job-newer") === "succeeded");
        yield* worker.stop();
      }),
    ),
    cleanup,
    processor,
  );

  expect(events).toEqual([
    "job-older:analyze:analyzing",
    "job-older:process:processing",
    "job-older:cleanup",
    "job-newer:analyze:analyzing",
    "job-newer:process:processing",
    "job-newer:cleanup",
  ]);
  expect(database.db.select().from(jobs).where(eq(jobs.id, "job-older")).get()).toMatchObject({
    resultJson: '{"jobId":"job-older"}',
    state: "succeeded",
  });
  database.close();
});

it("pauses for a durable decision before reserving processing work", async () => {
  const database = await createTestDatabase();
  insertJobs(database, [jobValues("job-decision", 10)]);
  const events: Array<string> = [];
  const decision = {
    kind: "frame-rate",
    recommended: { maximum: 30, mode: "cap" },
    source: { denominator: 1, framesPerSecond: 60, numerator: 60 },
  } as const;
  const processor = JobProcessor.of({
    analyze: () => Effect.succeed({ decision, kind: "decision-required" }),
    process: () => Effect.sync(() => events.push("processed")),
  });
  const cleanup = JobCleanup.of({
    cleanup: () => Effect.sync(() => events.push("cleaned")),
  });

  await runWorkerTest(
    Effect.scoped(
      Effect.gen(function* () {
        const worker = yield* startJobWorker(database, workerOptions);
        yield* waitUntil(() => readState(database, "job-decision") === "awaiting-decision");
        yield* worker.stop();
      }),
    ),
    cleanup,
    processor,
  );

  expect(database.db.select().from(jobs).where(eq(jobs.id, "job-decision")).get()).toMatchObject({
    decisionJson: JSON.stringify(decision),
    leaseExpiresAt: null,
    leaseOwner: null,
    progress: 5,
    state: "awaiting-decision",
  });
  expect(database.sqlite.prepare("select outcome from job_attempts").get()).toEqual({
    outcome: "decision-required",
  });
  expect(
    claimNextJob(database, { leaseDurationMs: 100, now: 50, workerId: "another-worker" }),
  ).toBeUndefined();
  expect(events).toEqual([]);
  expect(requestJobCancellation(database, "job-decision", "user-1", 60)).toMatchObject({
    state: "canceled",
  });
  database.close();
});

it("never processes more jobs than its configured concurrency", async () => {
  const database = await createTestDatabase();
  insertJobs(
    database,
    Array.from({ length: 5 }, (_, index) => jobValues(`job-${index}`, index)),
  );
  const release = Effect.runSync(Deferred.make<void>());
  const state = { active: 0, maximum: 0 };
  const processor = JobProcessor.of({
    analyze: () => Effect.succeed(metered(null)),
    process: (job) =>
      Effect.gen(function* () {
        state.active += 1;
        state.maximum = Math.max(state.maximum, state.active);
        yield* Deferred.await(release);
        return { jobId: job.id };
      }).pipe(Effect.ensuring(Effect.sync(() => (state.active -= 1)))),
  });
  const cleanup = JobCleanup.of({ cleanup: () => Effect.void });

  await runWorkerTest(
    Effect.scoped(
      Effect.gen(function* () {
        const worker = yield* startJobWorker(database, { ...workerOptions, concurrency: 2 });
        yield* waitUntil(() => state.active === 2);
        expect(countState(database, "processing")).toBe(2);
        expect(countState(database, "queued")).toBe(3);
        yield* Deferred.succeed(release, undefined);
        yield* waitUntil(() => countState(database, "succeeded") === 5);
        yield* worker.stop();
      }),
    ),
    cleanup,
    processor,
  );

  expect(state.maximum).toBe(2);
  database.close();
});

it("persists typed processor failures and cleans up terminal work", async () => {
  const database = await createTestDatabase();
  insertJobs(database, [jobValues("job-failed", 10)]);
  const cleaned: Array<string> = [];
  const processor = JobProcessor.of({
    analyze: () => Effect.succeed(metered(null)),
    process: () =>
      Effect.fail(
        new JobProcessorError({
          code: "BAD_MEDIA",
          details: { stage: "encode" },
          message: "The input cannot be encoded.",
        }),
      ),
  });
  const cleanup = JobCleanup.of({
    cleanup: (job) => Effect.sync(() => cleaned.push(job.id)),
  });

  await runWorkerTest(
    Effect.scoped(
      Effect.gen(function* () {
        const worker = yield* startJobWorker(database, workerOptions);
        yield* waitUntil(() => readState(database, "job-failed") === "failed");
        yield* worker.stop();
      }),
    ),
    cleanup,
    processor,
  );

  expect(database.db.select().from(jobs).where(eq(jobs.id, "job-failed")).get()).toMatchObject({
    errorCode: "BAD_MEDIA",
    errorJson: '{"message":"The input cannot be encoded.","details":{"stage":"encode"}}',
    state: "failed",
  });
  expect(cleaned).toEqual(["job-failed"]);
  database.close();
});

it("contains processor defects as terminal internal failures", async () => {
  const database = await createTestDatabase();
  insertJobs(database, [jobValues("job-defect", 10)]);
  const cleaned: Array<string> = [];
  const processor = JobProcessor.of({
    analyze: () => Effect.succeed(metered(null)),
    process: () => Effect.die("sensitive defect"),
  });
  const cleanup = JobCleanup.of({
    cleanup: (job) => Effect.sync(() => cleaned.push(job.id)),
  });

  await runWorkerTest(
    Effect.scoped(
      Effect.gen(function* () {
        const worker = yield* startJobWorker(database, workerOptions);
        yield* waitUntil(() => readState(database, "job-defect") === "failed");
        yield* worker.stop();
      }),
    ),
    cleanup,
    processor,
  );

  const failed = database.db.select().from(jobs).where(eq(jobs.id, "job-defect")).get();
  expect(failed).toMatchObject({ errorCode: "JOB_PROCESSOR_DEFECT", state: "failed" });
  expect(failed?.errorJson).not.toContain("sensitive defect");
  expect(cleaned).toEqual(["job-defect"]);
  database.close();
});

it("interrupts processing when cooperative cancellation is requested", async () => {
  const database = await createTestDatabase();
  insertJobs(database, [jobValues("job-canceled", 10)]);
  const events: Array<string> = [];
  const processor = JobProcessor.of({
    analyze: () => Effect.succeed(metered(null)),
    process: () =>
      Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => events.push("interrupted")))),
  });
  const cleanup = JobCleanup.of({
    cleanup: (job) => Effect.sync(() => events.push(`cleanup:${job.id}`)),
  });

  await runWorkerTest(
    Effect.scoped(
      Effect.gen(function* () {
        const worker = yield* startJobWorker(database, workerOptions);
        yield* waitUntil(() => readState(database, "job-canceled") === "processing");
        requestJobCancellation(database, "job-canceled", "user-1", 5);
        yield* TestClock.adjust(workerOptions.heartbeatIntervalMs);
        yield* waitUntil(() => readState(database, "job-canceled") === "canceled");
        yield* worker.stop();
      }),
    ),
    cleanup,
    processor,
  );

  expect(events).toEqual(["interrupted", "cleanup:job-canceled"]);
  expect(database.sqlite.prepare("select outcome from job_attempts").get()).toEqual({
    outcome: "interrupted",
  });
  database.close();
});

it("gives a cancellation request precedence over a simultaneous processor failure", async () => {
  const database = await createTestDatabase();
  insertJobs(database, [jobValues("job-race", 10)]);
  const release = Effect.runSync(Deferred.make<void>());
  const processor = JobProcessor.of({
    analyze: () => Effect.succeed(metered(null)),
    process: () =>
      Deferred.await(release).pipe(
        Effect.andThen(
          Effect.fail(
            new JobProcessorError({
              code: "PROCESS_FAILED",
              details: {},
              message: "Processing failed.",
            }),
          ),
        ),
      ),
  });
  const cleanup = JobCleanup.of({ cleanup: () => Effect.void });

  await runWorkerTest(
    Effect.scoped(
      Effect.gen(function* () {
        const worker = yield* startJobWorker(database, workerOptions);
        yield* waitUntil(() => readState(database, "job-race") === "processing");
        requestJobCancellation(database, "job-race", "user-1", 5);
        yield* Deferred.succeed(release, undefined);
        yield* waitUntil(() => readState(database, "job-race") === "canceled");
        yield* worker.stop();
      }),
    ),
    cleanup,
    processor,
  );

  expect(readState(database, "job-race")).toBe("canceled");
  database.close();
});

it("periodically renews the lease while a processor is active", async () => {
  const database = await createTestDatabase();
  insertJobs(database, [jobValues("job-heartbeat", 10)]);
  const release = Effect.runSync(Deferred.make<void>());
  const processor = JobProcessor.of({
    analyze: () => Effect.succeed(metered(null)),
    process: () => Deferred.await(release).pipe(Effect.as({ finished: true })),
  });
  const cleanup = JobCleanup.of({ cleanup: () => Effect.void });

  await runWorkerTest(
    Effect.scoped(
      Effect.gen(function* () {
        const worker = yield* startJobWorker(database, workerOptions);
        yield* waitUntil(() => readState(database, "job-heartbeat") === "processing");
        expect(readLease(database, "job-heartbeat")).toBe(100);
        yield* TestClock.adjust(20);
        expect(readLease(database, "job-heartbeat")).toBe(120);
        yield* TestClock.adjust(20);
        expect(readLease(database, "job-heartbeat")).toBe(140);
        yield* Deferred.succeed(release, undefined);
        yield* waitUntil(() => readState(database, "job-heartbeat") === "succeeded");
        yield* worker.stop();
      }),
    ),
    cleanup,
    processor,
  );

  database.close();
});

it("stops gracefully after active work without claiming another job", async () => {
  const database = await createTestDatabase();
  insertJobs(database, [jobValues("job-active", 10), jobValues("job-waiting", 20)]);
  const release = Effect.runSync(Deferred.make<void>());
  const processed: Array<string> = [];
  const processor = JobProcessor.of({
    analyze: () => Effect.succeed(metered(null)),
    process: (job) =>
      Deferred.await(release).pipe(
        Effect.andThen(Effect.sync(() => processed.push(job.id))),
        Effect.as({ jobId: job.id }),
      ),
  });
  const cleanup = JobCleanup.of({ cleanup: () => Effect.void });

  await runWorkerTest(
    Effect.scoped(
      Effect.gen(function* () {
        const worker = yield* startJobWorker(database, workerOptions);
        yield* waitUntil(() => readState(database, "job-active") === "processing");
        const stopping = yield* Effect.forkChild(worker.stop());
        yield* Effect.yieldNow;
        expect(stopping.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(stopping);
      }),
    ),
    cleanup,
    processor,
  );

  expect(processed).toEqual(["job-active"]);
  expect(readState(database, "job-active")).toBe("succeeded");
  expect(readState(database, "job-waiting")).toBe("queued");
  database.close();
});

it("recovers expired leases before accepting new work", async () => {
  const database = await createTestDatabase();
  insertJobs(database, [jobValues("job-recovered", 10)]);
  claimNextJob(database, { leaseDurationMs: 10, now: 0, workerId: "dead-worker" });
  const attempts: Array<number> = [];
  const processor = JobProcessor.of({
    analyze: (job) =>
      Effect.sync(() => {
        attempts.push(job.attemptCount);
        return metered(null);
      }),
    process: () => Effect.succeed({ recovered: true }),
  });
  const cleanup = JobCleanup.of({ cleanup: () => Effect.void });

  await runWorkerTest(
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(20);
        const worker = yield* startJobWorker(database, workerOptions);
        yield* waitUntil(() => readState(database, "job-recovered") === "succeeded");
        yield* worker.stop();
      }),
    ),
    cleanup,
    processor,
  );

  expect(attempts).toEqual([2]);
  expect(
    database.sqlite.prepare("select outcome from job_attempts order by attempt").all(),
  ).toEqual([{ outcome: "interrupted" }, { outcome: "succeeded" }]);
  database.close();
});

it("cleans up leases that recovery terminally fails or cancels", async () => {
  const database = await createTestDatabase();
  insertJobs(database, [jobValues("job-exhausted", 10), jobValues("job-aborted", 20)]);
  claimNextJob(database, { leaseDurationMs: 10, now: 0, workerId: "dead-worker-a" });
  claimNextJob(database, { leaseDurationMs: 10, now: 1, workerId: "dead-worker-b" });
  requestJobCancellation(database, "job-aborted", "user-1", 5);
  const cleaned: Array<string> = [];
  const processor = JobProcessor.of({
    analyze: () => Effect.succeed(metered(null)),
    process: () => Effect.succeed(null),
  });
  const cleanup = JobCleanup.of({
    cleanup: (job) => Effect.sync(() => cleaned.push(job.id)),
  });

  await runWorkerTest(
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(20);
        const worker = yield* startJobWorker(database, { ...workerOptions, maxAttempts: 1 });
        yield* worker.stop();
      }),
    ),
    cleanup,
    processor,
  );

  expect(cleaned).toEqual(["job-exhausted", "job-aborted"]);
  expect(readState(database, "job-exhausted")).toBe("failed");
  expect(readState(database, "job-aborted")).toBe("canceled");
  database.close();
});

const runWorkerTest = <Value>(
  effect: Effect.Effect<Value, never, JobCleanup | JobProcessor>,
  cleanup: JobCleanup["Service"],
  processor: JobProcessor["Service"],
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(JobCleanup, cleanup),
      Effect.provideService(JobProcessor, processor),
      Effect.provide(TestClock.layer()),
    ),
  );

const waitUntil = Effect.fn("test.waitUntil")(function* (predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    yield* Effect.yieldNow;
  }
  return yield* Effect.die("Timed out waiting for worker state.");
});

const createTestDatabase = async () => {
  const directory = await mkdtemp(join(tmpdir(), "densio-worker-"));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, "database.sqlite"));
  migrateDatabase(database);
  database.db
    .insert(users)
    .values({ id: "user-1", email: "a@example.com", createdAt: 1, updatedAt: 1 })
    .run();
  return database;
};

const insertJobs = (database: Database, values: ReadonlyArray<typeof jobs.$inferInsert>) => {
  values.forEach((value) =>
    createJob(database, value, { creditPeriodStart: 0, monthlyCredits: 30 }),
  );
};

const readState = (database: Database, id: string) =>
  database.db.select({ state: jobs.state }).from(jobs).where(eq(jobs.id, id)).get()?.state;

const countState = (database: Database, state: Job["state"]) =>
  database.db.select().from(jobs).where(eq(jobs.state, state)).all().length;

const readLease = (database: Database, id: string) =>
  database.db.select({ lease: jobs.leaseExpiresAt }).from(jobs).where(eq(jobs.id, id)).get()?.lease;

const metered = (data: Schema.Json) => ({ creditUnits: 5, data, kind: "ready" as const });

const jobValues = (id: string, createdAt: number) => ({
  createdAt,
  declaredBytes: 100,
  id,
  kind: "compress" as const,
  optionsJson: "{}",
  plan: "free" as const,
  sourceFilename: "input.mp4",
  state: "queued" as const,
  updatedAt: createdAt,
  userId: "user-1",
});
