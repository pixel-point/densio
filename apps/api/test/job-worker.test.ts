import { makeJobProcessor } from "./job-processor-fixture.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { Clock, Deferred, Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { onTestFinished, afterEach, expect, it } from "vitest";

import { migrateDatabase, openDatabase, type Database } from "../src/database/database.ts";
import { claimNextJob } from "../src/database/job-repository.ts";
import { transitionJob } from "../src/database/job-transition-repository.ts";
import { queueCanonicalJob } from "./job-fixture.ts";
import { artifacts, jobCreditEntries, jobs, users } from "../src/database/schema.ts";
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

it("fails a planned job before encoding when trusted analysis diverges from its quote", async () => {
  const database = await createTestDatabase();
  queueCanonicalJob(database, { ...jobValues("planned", 10), quoteCreditUnits: 10 });
  const state = { processed: false };
  const processor = makeJobProcessor({
    analyze: () => Effect.succeed({ creditUnits: 5, data: null, kind: "ready" }),
    process: () => Effect.sync(() => (state.processed = true)),
  });
  const cleanup = JobCleanup.of({ cleanup: () => Effect.void });

  await runWorkerTest(
    database,
    Effect.scoped(
      Effect.gen(function* () {
        const worker = yield* startJobWorker(database, workerOptions);
        yield* waitUntil(() => readState(database, "planned") === "failed");
        yield* worker.stop();
      }),
    ),
    cleanup,
    processor,
  );

  expect(state.processed).toBe(false);
  expect(database.db.select().from(jobs).where(eq(jobs.id, "planned")).get()).toMatchObject({
    errorCode: "PLAN_DIVERGED",
    state: "failed",
  });
  expect(
    database.db
      .select({ kind: jobCreditEntries.kind, units: jobCreditEntries.units })
      .from(jobCreditEntries)
      .all(),
  ).toEqual([
    { kind: "hold", units: 10 },
    { kind: "release", units: 10 },
  ]);
  database.close();
});

it("charges the exact reservation when the completed encode exceeds its output guard", async () => {
  const database = await createTestDatabase();
  queueCanonicalJob(database, jobValues("guarded", 10));
  const processor = makeJobProcessor({
    analyze: () => Effect.succeed(metered(null)),
    process: () =>
      Effect.fail(
        new JobProcessorError({
          code: "OUTPUT_SIZE_LIMIT_EXCEEDED",
          details: { actualBytes: 20, limitBytes: 10 },
          message: "The encoded outputs exceed the configured byte guard.",
        }),
      ),
  });
  const cleanup = JobCleanup.of({ cleanup: () => Effect.void });

  await runWorkerTest(
    database,
    Effect.scoped(
      Effect.gen(function* () {
        const worker = yield* startJobWorker(database, workerOptions);
        yield* waitUntil(() => readState(database, "guarded") === "failed");
        yield* worker.stop();
      }),
    ),
    cleanup,
    processor,
  );

  expect(
    database.db
      .select({ kind: jobCreditEntries.kind, units: jobCreditEntries.units })
      .from(jobCreditEntries)
      .all(),
  ).toEqual([
    { kind: "hold", units: 5 },
    { kind: "release", units: 5 },
    { kind: "usage", units: 5 },
  ]);
  database.close();
});

it("claims oldest-first and transitions analyze to processing to success", async () => {
  const database = await createTestDatabase();
  insertJobs(database, [jobValues("job-newer", 20), jobValues("job-older", 10)]);
  const events: Array<string> = [];
  const processor = makeJobProcessor({
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
    database,
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
    resultJson: JSON.stringify({
      kind: "compress",
      artifactIds: ["artifact-job-older"],
      html: "<video></video>",
    }),
    state: "succeeded",
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
  const processor = makeJobProcessor({
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
    database,
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

it("assigns distinct lease owners to worker instances with the same configured id", async () => {
  const database = await createTestDatabase();
  insertJobs(database, [jobValues("job-first", 10), jobValues("job-second", 20)]);
  const release = Effect.runSync(Deferred.make<void>());
  const leaseOwners: Array<string | null> = [];
  const processor = makeJobProcessor({
    analyze: (job) =>
      Effect.sync(() => {
        leaseOwners.push(job.leaseOwner);
        return metered(null);
      }),
    process: () => Deferred.await(release).pipe(Effect.as(null)),
  });
  const cleanup = JobCleanup.of({ cleanup: () => Effect.void });

  await runWorkerTest(
    database,
    Effect.scoped(
      Effect.gen(function* () {
        const firstWorker = yield* startJobWorker(database, workerOptions);
        yield* waitUntil(() => leaseOwners.length === 1);
        const secondWorker = yield* startJobWorker(database, workerOptions);
        yield* waitUntil(() => leaseOwners.length === 2);
        expect(leaseOwners.every((owner) => owner?.startsWith("worker-test-"))).toBe(true);
        expect(new Set(leaseOwners).size).toBe(2);
        yield* Deferred.succeed(release, undefined);
        yield* waitUntil(() => countState(database, "succeeded") === 2);
        yield* firstWorker.stop();
        yield* secondWorker.stop();
      }),
    ),
    cleanup,
    processor,
  );

  database.close();
});

it("persists typed processor failures and cleans up terminal work", async () => {
  const database = await createTestDatabase();
  insertJobs(database, [jobValues("job-failed", 10)]);
  const cleaned: Array<string> = [];
  const processor = makeJobProcessor({
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
    database,
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
  const processor = makeJobProcessor({
    analyze: () => Effect.succeed(metered(null)),
    process: () => Effect.die("sensitive defect"),
  });
  const cleanup = JobCleanup.of({
    cleanup: (job) => Effect.sync(() => cleaned.push(job.id)),
  });

  await runWorkerTest(
    database,
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
  const processor = makeJobProcessor({
    analyze: () => Effect.succeed(metered(null)),
    process: () =>
      Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => events.push("interrupted")))),
  });
  const cleanup = JobCleanup.of({
    cleanup: (job) => Effect.sync(() => events.push(`cleanup:${job.id}`)),
  });

  await runWorkerTest(
    database,
    Effect.scoped(
      Effect.gen(function* () {
        const worker = yield* startJobWorker(database, workerOptions);
        yield* waitUntil(() => readState(database, "job-canceled") === "processing");
        transitionJob(database, { jobId: "job-canceled", now: 5, command: { type: "cancel" } });
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
  const processor = makeJobProcessor({
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
    database,
    Effect.scoped(
      Effect.gen(function* () {
        const worker = yield* startJobWorker(database, workerOptions);
        yield* waitUntil(() => readState(database, "job-race") === "processing");
        transitionJob(database, { jobId: "job-race", now: 5, command: { type: "cancel" } });
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
  const processor = makeJobProcessor({
    analyze: () => Effect.succeed(metered(null)),
    process: () => Deferred.await(release).pipe(Effect.as({ finished: true })),
  });
  const cleanup = JobCleanup.of({ cleanup: () => Effect.void });

  await runWorkerTest(
    database,
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
  const processor = makeJobProcessor({
    analyze: () => Effect.succeed(metered(null)),
    process: (job) =>
      Deferred.await(release).pipe(
        Effect.andThen(Effect.sync(() => processed.push(job.id))),
        Effect.as({ jobId: job.id }),
      ),
  });
  const cleanup = JobCleanup.of({ cleanup: () => Effect.void });

  await runWorkerTest(
    database,
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
  const processor = makeJobProcessor({
    analyze: (job) =>
      Effect.sync(() => {
        attempts.push(job.attemptCount);
        return metered(null);
      }),
    process: () => Effect.succeed({ recovered: true }),
  });
  const cleanup = JobCleanup.of({ cleanup: () => Effect.void });

  await runWorkerTest(
    database,
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
  transitionJob(database, { jobId: "job-aborted", now: 5, command: { type: "cancel" } });
  const cleaned: Array<string> = [];
  const processor = makeJobProcessor({
    analyze: () => Effect.succeed(metered(null)),
    process: () => Effect.succeed(null),
  });
  const cleanup = JobCleanup.of({
    cleanup: (job) => Effect.sync(() => cleaned.push(job.id)),
  });

  await runWorkerTest(
    database,
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
  database: Database,
  effect: Effect.Effect<Value, never, JobCleanup | JobProcessor>,
  cleanup: JobCleanup["Service"],
  processor: JobProcessor["Service"],
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(JobCleanup, cleanup),
      Effect.provideService(JobProcessor, withPublishedOutput(database, processor)),
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
  onTestFinished(() => {
    if (database.sqlite.isOpen) database.close();
  });
  migrateDatabase(database);
  database.db
    .insert(users)
    .values({ id: "user-1", email: "a@example.com", createdAt: 1, updatedAt: 1 })
    .run();
  return database;
};

const insertJobs = (database: Database, values: ReadonlyArray<ReturnType<typeof jobValues>>) => {
  values.forEach((value) => queueCanonicalJob(database, value));
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
  subscriptionPlan: "free" as const,
  sourceFilename: "input.mp4",
  quoteCreditUnits: 5,
  updatedAt: createdAt,
  organizationId: "org-1",
  createdByUserId: "user-1",
});

const withPublishedOutput = (database: Database, processor: JobProcessor["Service"]) =>
  JobProcessor.of({
    analyze: (initialJob) =>
      processor.analyze(initialJob).pipe(
        Effect.map((analysis) => ({
          ...analysis,
          process: (job: Job) =>
            analysis.process(job).pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  const now = yield* Clock.currentTimeMillis;
                  if (job.leaseOwner === null) return yield* Effect.die("Expected an active lease");
                  transitionJob(database, {
                    jobId: job.id,
                    now,
                    command: {
                      type: "publishing",
                      workerId: job.leaseOwner,
                      attempt: job.attemptCount,
                    },
                  });
                  const artifactId = `artifact-${job.id}`;
                  database.db
                    .insert(artifacts)
                    .values({
                      id: artifactId,
                      organizationId: job.organizationId,
                      jobId: job.id,
                      createdAt: now,
                      filename: "video.webm",
                      kind: "video",
                      mediaType: "video/webm",
                      path: `/unused/${artifactId}`,
                      sizeBytes: 5,
                      sha256: "a".repeat(64),
                      retainedUntil: now + 60_000,
                    })
                    .run();
                  return { kind: "compress", artifactIds: [artifactId], html: "<video></video>" };
                }),
              ),
            ),
        })),
      ),
  });
