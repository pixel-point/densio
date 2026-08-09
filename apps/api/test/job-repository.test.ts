import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";

import { migrateDatabase, openDatabase } from "../src/database/database.ts";
import {
  claimNextJob,
  cancelClaimedJob,
  completeJob,
  createJob,
  failJob,
  isJobCancellationRequested,
  renewJobLease,
  recoverExpiredJobs,
  requestJobCancellation,
  reserveJobCreditsAndMarkProcessing,
} from "../src/database/job-repository.ts";
import { jobs, users } from "../src/database/schema.ts";

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

it("claims queued jobs oldest-first with an atomic lease", async () => {
  const database = await createTestDatabase();
  database.db
    .insert(users)
    .values({ id: "user-1", email: "a@example.com", createdAt: 1, updatedAt: 1 })
    .run();
  database.db.insert(jobs).values(jobValues("job-newer", 20)).run();
  database.db.insert(jobs).values(jobValues("job-older", 10)).run();

  const first = claimNextJob(database, {
    leaseDurationMs: 60_000,
    now: 100,
    workerId: "worker-1",
  });
  const second = claimNextJob(database, {
    leaseDurationMs: 60_000,
    now: 101,
    workerId: "worker-2",
  });

  expect(first).toMatchObject({
    attemptCount: 1,
    id: "job-older",
    leaseExpiresAt: 60_100,
    leaseOwner: "worker-1",
    state: "analyzing",
  });
  expect(second?.id).toBe("job-newer");
  expect(
    claimNextJob(database, {
      leaseDurationMs: 60_000,
      now: 102,
      workerId: "worker-3",
    }),
  ).toBeUndefined();

  database.close();
});

it("claims paid work before older Free work", async () => {
  const database = await createTestDatabase();
  database.db
    .insert(users)
    .values({ id: "user-1", email: "a@example.com", createdAt: 1, updatedAt: 1 })
    .run();
  database.db.insert(jobs).values(jobValues("job-free", 10)).run();
  database.db
    .insert(jobs)
    .values({ ...jobValues("job-paid", 20), plan: "basic", queuePriority: 10 })
    .run();

  const claimed = claimNextJob(database, {
    leaseDurationMs: 60_000,
    now: 100,
    workerId: "worker-1",
  });

  expect(claimed?.id).toBe("job-paid");
  database.close();
});

it("claims by the snapshotted numeric queue priority instead of plan name", async () => {
  const database = await createTestDatabase();
  database.db
    .insert(users)
    .values({ id: "user-1", email: "a@example.com", createdAt: 1, updatedAt: 1 })
    .run();
  database.db.insert(jobs).values(jobValues("job-lower", 10)).run();
  database.db
    .insert(jobs)
    .values({ ...jobValues("job-higher", 20), queuePriority: 30 })
    .run();

  const claimed = claimNextJob(database, {
    leaseDurationMs: 60_000,
    now: 100,
    workerId: "worker-1",
  });

  expect(claimed?.id).toBe("job-higher");
  database.close();
});

it("returns the original job when an idempotency key is retried", async () => {
  const database = await createTestDatabase();
  database.db
    .insert(users)
    .values({ id: "user-1", email: "a@example.com", createdAt: 1, updatedAt: 1 })
    .run();

  const first = createJob(
    database,
    {
      ...jobValues("job-first", 10),
      idempotencyKey: "request-1",
      state: "awaiting-upload",
    },
    { creditPeriodStart: 0, monthlyCredits: 1 },
  );
  const retried = createJob(
    database,
    {
      ...jobValues("job-retry", 20),
      idempotencyKey: "request-1",
      state: "awaiting-upload",
    },
    { creditPeriodStart: 0, monthlyCredits: 1 },
  );

  expect(first).toMatchObject({ created: true, job: { id: "job-first" } });
  expect(retried).toMatchObject({ created: false, job: { id: "job-first" } });
  expect(database.db.select().from(jobs).all()).toHaveLength(1);

  database.close();
});

it("snapshots queue priority from the plan when creating a job", async () => {
  const database = await createTestDatabase();
  database.db
    .insert(users)
    .values({ id: "user-1", email: "a@example.com", createdAt: 1, updatedAt: 1 })
    .run();

  const created = createJob(
    database,
    { ...jobValues("job-basic", 10), plan: "basic" },
    { creditPeriodStart: 0, monthlyCredits: 750 },
  );

  expect(created).toMatchObject({ created: true, job: { queuePriority: 10 } });
  database.close();
});

it("atomically reserves the minimum job cost and rejects work after the allowance", async () => {
  const database = await createTestDatabase();
  database.db
    .insert(users)
    .values({ id: "user-1", email: "a@example.com", createdAt: 1, updatedAt: 1 })
    .run();

  const first = createJob(database, jobValues("job-1", 100), {
    creditPeriodStart: 0,
    monthlyCredits: 0.1,
  });
  const second = createJob(database, jobValues("job-2", 101), {
    creditPeriodStart: 0,
    monthlyCredits: 0.1,
  });
  const exhausted = createJob(database, jobValues("job-3", 102), {
    creditPeriodStart: 0,
    monthlyCredits: 0.1,
  });

  expect(first).toMatchObject({ created: true, job: { id: "job-1" } });
  expect(second).toMatchObject({ created: true, job: { id: "job-2" } });
  expect(exhausted).toEqual({ availableCredits: 0, kind: "insufficient-credits" });
  expect(database.db.select().from(jobs).all()).toHaveLength(2);

  database.close();
});

it("does not count released or previous-period entries against the allowance", async () => {
  const database = await createTestDatabase();
  database.db
    .insert(users)
    .values({ id: "user-1", email: "a@example.com", createdAt: 1, updatedAt: 1 })
    .run();
  createJob(database, jobValues("job-old", 99), { creditPeriodStart: 0, monthlyCredits: 0.05 });
  requestJobCancellation(database, "job-old", "user-1", 100);

  expect(
    createJob(database, jobValues("job-current", 102), {
      creditPeriodStart: 100,
      monthlyCredits: 0.05,
    }),
  ).toMatchObject({ created: true, job: { id: "job-current" } });

  database.close();
});

it("cancels queued work and requests cooperative cancellation for active work", async () => {
  const database = await createTestDatabase();
  database.db
    .insert(users)
    .values({ id: "user-1", email: "a@example.com", createdAt: 1, updatedAt: 1 })
    .run();
  database.db.insert(jobs).values(jobValues("job-queued", 10)).run();
  database.db
    .insert(jobs)
    .values({
      ...jobValues("job-active", 20),
      leaseExpiresAt: 1_000,
      leaseOwner: "worker-1",
      state: "processing",
    })
    .run();

  const queued = requestJobCancellation(database, "job-queued", "user-1", 50);
  const active = requestJobCancellation(database, "job-active", "user-1", 60);

  expect(queued).toMatchObject({ completedAt: 50, state: "canceled" });
  expect(active).toMatchObject({ cancelRequestedAt: 60, state: "processing" });
  expect(isJobCancellationRequested(database, "job-active", "worker-1")).toBe(true);

  database.close();
});

it("completes only the worker-owned attempt and persists its result atomically", async () => {
  const database = await createTestDatabase();
  database.db
    .insert(users)
    .values({ id: "user-1", email: "a@example.com", createdAt: 1, updatedAt: 1 })
    .run();
  createJob(database, jobValues("job-1", 10), { creditPeriodStart: 0, monthlyCredits: 1 });
  claimNextJob(database, { leaseDurationMs: 100, now: 20, workerId: "worker-1" });

  expect(
    reserveJobCreditsAndMarkProcessing(database, {
      creditUnits: 5,
      jobId: "job-1",
      leaseDurationMs: 100,
      monthlyCreditUnits: 100,
      now: 30,
      workerId: "another-worker",
    }),
  ).toBeUndefined();
  expect(
    reserveJobCreditsAndMarkProcessing(database, {
      creditUnits: 5,
      jobId: "job-1",
      leaseDurationMs: 100,
      monthlyCreditUnits: 100,
      now: 30,
      workerId: "worker-1",
    }),
  ).toMatchObject({ progress: 10, state: "processing" });

  const completed = completeJob(database, {
    jobId: "job-1",
    now: 40,
    resultJson: '{"kind":"compress"}',
    workerId: "worker-1",
  });

  expect(completed).toMatchObject({
    completedAt: 40,
    leaseOwner: null,
    progress: 100,
    resultJson: '{"kind":"compress"}',
    state: "succeeded",
  });
  expect(database.sqlite.prepare("select outcome from job_attempts").get()).toEqual({
    outcome: "succeeded",
  });

  database.close();
});

it("requeues interrupted leases but terminally fails exhausted attempts", async () => {
  const database = await createTestDatabase();
  database.db
    .insert(users)
    .values({ id: "user-1", email: "a@example.com", createdAt: 1, updatedAt: 1 })
    .run();
  database.db.insert(jobs).values(jobValues("job-retry", 10)).run();
  database.db.insert(jobs).values(jobValues("job-exhausted", 20)).run();
  claimNextJob(database, { leaseDurationMs: 10, now: 30, workerId: "worker-1" });
  claimNextJob(database, { leaseDurationMs: 10, now: 31, workerId: "worker-2" });
  database.db.update(jobs).set({ attemptCount: 2 }).where(eq(jobs.id, "job-exhausted")).run();

  expect(recoverExpiredJobs(database, { maxAttempts: 2, now: 50 })).toEqual({
    canceled: [],
    failed: ["job-exhausted"],
    requeued: ["job-retry"],
  });
  expect(database.db.select().from(jobs).where(eq(jobs.id, "job-retry")).get()).toMatchObject({
    leaseOwner: null,
    state: "queued",
  });
  expect(database.db.select().from(jobs).where(eq(jobs.id, "job-exhausted")).get()).toMatchObject({
    errorCode: "JOB_ATTEMPTS_EXHAUSTED",
    state: "failed",
  });

  database.close();
});

it("records a typed worker failure and clears its lease", async () => {
  const database = await createTestDatabase();
  database.db
    .insert(users)
    .values({ id: "user-1", email: "a@example.com", createdAt: 1, updatedAt: 1 })
    .run();
  database.db.insert(jobs).values(jobValues("job-1", 10)).run();
  claimNextJob(database, { leaseDurationMs: 100, now: 20, workerId: "worker-1" });

  const failed = failJob(database, {
    errorCode: "MEDIA_PROCESS_FAILED",
    errorJson: '{"detail":"bad input"}',
    jobId: "job-1",
    now: 30,
    workerId: "worker-1",
  });

  expect(failed).toMatchObject({
    completedAt: 30,
    errorCode: "MEDIA_PROCESS_FAILED",
    leaseExpiresAt: null,
    leaseOwner: null,
    state: "failed",
  });
  expect(database.sqlite.prepare("select outcome from job_attempts").get()).toEqual({
    outcome: "failed",
  });

  database.close();
});

it("renews only a live lease owned by the calling worker", async () => {
  const database = await createTestDatabase();
  database.db
    .insert(users)
    .values({ id: "user-1", email: "a@example.com", createdAt: 1, updatedAt: 1 })
    .run();
  database.db.insert(jobs).values(jobValues("job-1", 10)).run();
  claimNextJob(database, { leaseDurationMs: 100, now: 20, workerId: "worker-1" });

  expect(
    renewJobLease(database, {
      jobId: "job-1",
      leaseDurationMs: 100,
      now: 50,
      workerId: "worker-1",
    }),
  ).toMatchObject({ leaseExpiresAt: 150, updatedAt: 50 });
  expect(
    renewJobLease(database, {
      jobId: "job-1",
      leaseDurationMs: 100,
      now: 60,
      workerId: "worker-2",
    }),
  ).toBeUndefined();
  expect(
    renewJobLease(database, {
      jobId: "job-1",
      leaseDurationMs: 100,
      now: 151,
      workerId: "worker-1",
    }),
  ).toBeUndefined();

  database.close();
});

it("cancels only worker-owned active work and closes its attempt", async () => {
  const database = await createTestDatabase();
  database.db
    .insert(users)
    .values({ id: "user-1", email: "a@example.com", createdAt: 1, updatedAt: 1 })
    .run();
  database.db.insert(jobs).values(jobValues("job-1", 10)).run();
  claimNextJob(database, { leaseDurationMs: 100, now: 20, workerId: "worker-1" });
  requestJobCancellation(database, "job-1", "user-1", 30);

  expect(
    cancelClaimedJob(database, { jobId: "job-1", now: 40, workerId: "worker-2" }),
  ).toBeUndefined();
  expect(
    cancelClaimedJob(database, { jobId: "job-1", now: 40, workerId: "worker-1" }),
  ).toMatchObject({ completedAt: 40, leaseOwner: null, state: "canceled" });
  expect(database.sqlite.prepare("select outcome from job_attempts").get()).toEqual({
    outcome: "interrupted",
  });

  database.close();
});

const createTestDatabase = async () => {
  const directory = await mkdtemp(join(tmpdir(), "densio-repository-"));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, "database.sqlite"));
  migrateDatabase(database);
  return database;
};

const jobValues = (id: string, createdAt: number) => ({
  createdAt,
  declaredBytes: 100,
  maxUploadBytes: 1_000_000_000,
  id,
  kind: "compress" as const,
  optionsJson: "{}",
  plan: "free" as const,
  sourceFilename: "input.mp4",
  state: "queued" as const,
  updatedAt: createdAt,
  userId: "user-1",
});
