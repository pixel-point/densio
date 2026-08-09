import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { migrateDatabase, openDatabase } from "../src/database/database.ts";
import {
  cancelClaimedJob,
  claimNextJob,
  completeJob,
  createJob,
  failJob,
  recoverExpiredJobs,
  requestJobCancellation,
  reserveJobCreditsAndMarkProcessing,
} from "../src/database/job-repository.ts";
import { expireAwaitingUpload } from "../src/database/job-lifecycle-repository.ts";
import { jobCreditEntries, jobs, users } from "../src/database/schema.ts";

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

it("settles an exact reservation into append-only usage entries", async () => {
  const database = await createTestDatabase();
  insertUser(database);
  createJob(database, jobValues("job-1", 100), { creditPeriodStart: 0, monthlyCredits: 1 });
  claimNextJob(database, { leaseDurationMs: 100, now: 110, workerId: "worker-1" });

  expect(
    reserveJobCreditsAndMarkProcessing(database, {
      creditUnits: 45,
      jobId: "job-1",
      leaseDurationMs: 100,
      monthlyCreditUnits: 100,
      now: 120,
      workerId: "worker-1",
    }),
  ).toMatchObject({ state: "processing" });
  completeJob(database, {
    jobId: "job-1",
    now: 130,
    resultJson: '{"kind":"compress"}',
    workerId: "worker-1",
  });

  expect(
    database.db
      .select({ kind: jobCreditEntries.kind, units: jobCreditEntries.units })
      .from(jobCreditEntries)
      .all(),
  ).toEqual([
    { kind: "hold", units: 5 },
    { kind: "adjustment", units: 40 },
    { kind: "release", units: 45 },
    { kind: "usage", units: 45 },
  ]);
  database.close();
});

it("atomically rejects an exact reservation that exceeds the allowance", async () => {
  const database = await createTestDatabase();
  insertUser(database);
  createJob(database, jobValues("job-1", 100), { creditPeriodStart: 0, monthlyCredits: 1 });
  createJob(database, jobValues("job-2", 101), { creditPeriodStart: 0, monthlyCredits: 1 });
  claimNextJob(database, { leaseDurationMs: 100, now: 110, workerId: "worker-1" });
  reserveJobCreditsAndMarkProcessing(database, {
    creditUnits: 95,
    jobId: "job-1",
    leaseDurationMs: 100,
    monthlyCreditUnits: 100,
    now: 120,
    workerId: "worker-1",
  });
  claimNextJob(database, { leaseDurationMs: 100, now: 121, workerId: "worker-2" });

  expect(
    reserveJobCreditsAndMarkProcessing(database, {
      creditUnits: 10,
      jobId: "job-2",
      leaseDurationMs: 100,
      monthlyCreditUnits: 100,
      now: 122,
      workerId: "worker-2",
    }),
  ).toEqual({ availableUnits: 0, kind: "insufficient-credits" });
  expect(database.db.select().from(jobs).get()?.state).toBe("processing");
  expect(
    database.db
      .select()
      .from(jobs)
      .all()
      .find(({ id }) => id === "job-2")?.state,
  ).toBe("analyzing");
  database.close();
});

it("refuses to process a job whose initial credit hold is missing", async () => {
  const database = await createTestDatabase();
  insertUser(database);
  createJob(database, jobValues("job-1", 100), { creditPeriodStart: 0, monthlyCredits: 1 });
  database.db.delete(jobCreditEntries).run();
  claimNextJob(database, { leaseDurationMs: 100, now: 110, workerId: "worker-1" });

  expect(
    reserveJobCreditsAndMarkProcessing(database, {
      creditUnits: 45,
      jobId: "job-1",
      leaseDurationMs: 100,
      monthlyCreditUnits: 100,
      now: 120,
      workerId: "worker-1",
    }),
  ).toEqual({ kind: "missing-reservation" });
  expect(database.db.select().from(jobs).get()?.state).toBe("analyzing");
  expect(creditEntries(database)).toEqual([]);
  database.close();
});

it("releases the exact reservation when processing fails", async () => {
  const database = await createTestDatabase();
  insertUser(database);
  createJob(database, jobValues("job-1", 100), { creditPeriodStart: 0, monthlyCredits: 1 });
  claimNextJob(database, { leaseDurationMs: 100, now: 110, workerId: "worker-1" });
  reserveJobCreditsAndMarkProcessing(database, {
    creditUnits: 45,
    jobId: "job-1",
    leaseDurationMs: 100,
    monthlyCreditUnits: 100,
    now: 120,
    workerId: "worker-1",
  });

  failJob(database, {
    errorCode: "BAD_MEDIA",
    errorJson: "{}",
    jobId: "job-1",
    now: 130,
    workerId: "worker-1",
  });

  expect(creditEntries(database)).toEqual([
    { kind: "hold", units: 5 },
    { kind: "adjustment", units: 40 },
    { kind: "release", units: 45 },
  ]);
  database.close();
});

it("releases the minimum hold when queued work is canceled", async () => {
  const database = await createTestDatabase();
  insertUser(database);
  createJob(database, jobValues("job-1", 100), { creditPeriodStart: 0, monthlyCredits: 1 });

  requestJobCancellation(database, "job-1", "user-1", 110);

  expect(creditEntries(database)).toEqual([
    { kind: "hold", units: 5 },
    { kind: "release", units: 5 },
  ]);
  database.close();
});

it("releases the minimum hold when an upload expires", async () => {
  const database = await createTestDatabase();
  insertUser(database);
  createJob(
    database,
    { ...jobValues("job-1", 100), state: "awaiting-upload" },
    {
      creditPeriodStart: 0,
      monthlyCredits: 1,
    },
  );

  expireAwaitingUpload(database, { jobId: "job-1", now: 110, userId: "user-1" });

  expect(creditEntries(database)).toEqual([
    { kind: "hold", units: 5 },
    { kind: "release", units: 5 },
  ]);
  database.close();
});

it("releases the exact reservation when active work is canceled", async () => {
  const database = await createTestDatabase();
  insertUser(database);
  createJob(database, jobValues("job-1", 100), { creditPeriodStart: 0, monthlyCredits: 1 });
  claimNextJob(database, { leaseDurationMs: 100, now: 110, workerId: "worker-1" });
  reserveJobCreditsAndMarkProcessing(database, {
    creditUnits: 45,
    jobId: "job-1",
    leaseDurationMs: 100,
    monthlyCreditUnits: 100,
    now: 120,
    workerId: "worker-1",
  });
  requestJobCancellation(database, "job-1", "user-1", 130);

  cancelClaimedJob(database, { jobId: "job-1", now: 140, workerId: "worker-1" });

  expect(creditEntries(database)).toEqual([
    { kind: "hold", units: 5 },
    { kind: "adjustment", units: 40 },
    { kind: "release", units: 45 },
  ]);
  database.close();
});

it("retains a reservation across retry and releases it when attempts are exhausted", async () => {
  const database = await createTestDatabase();
  insertUser(database);
  createJob(database, jobValues("job-1", 100), { creditPeriodStart: 0, monthlyCredits: 1 });
  claimNextJob(database, { leaseDurationMs: 10, now: 110, workerId: "worker-1" });
  reserveJobCreditsAndMarkProcessing(database, {
    creditUnits: 45,
    jobId: "job-1",
    leaseDurationMs: 10,
    monthlyCreditUnits: 100,
    now: 111,
    workerId: "worker-1",
  });

  expect(recoverExpiredJobs(database, { maxAttempts: 2, now: 122 })).toEqual({
    canceled: [],
    failed: [],
    requeued: ["job-1"],
  });
  expect(creditEntries(database)).toEqual([
    { kind: "hold", units: 5 },
    { kind: "adjustment", units: 40 },
  ]);

  claimNextJob(database, { leaseDurationMs: 10, now: 130, workerId: "worker-2" });
  reserveJobCreditsAndMarkProcessing(database, {
    creditUnits: 45,
    jobId: "job-1",
    leaseDurationMs: 10,
    monthlyCreditUnits: 100,
    now: 131,
    workerId: "worker-2",
  });
  expect(recoverExpiredJobs(database, { maxAttempts: 2, now: 142 })).toEqual({
    canceled: [],
    failed: ["job-1"],
    requeued: [],
  });
  expect(creditEntries(database)).toEqual([
    { kind: "hold", units: 5 },
    { kind: "adjustment", units: 40 },
    { kind: "release", units: 45 },
  ]);
  database.close();
});

const createTestDatabase = async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffmpeg-api-credit-ledger-"));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, "test.sqlite"));
  migrateDatabase(database);
  return database;
};

const insertUser = (database: ReturnType<typeof openDatabase>) =>
  database.db
    .insert(users)
    .values({ id: "user-1", email: "a@example.com", createdAt: 1, updatedAt: 1 })
    .run();

const creditEntries = (database: ReturnType<typeof openDatabase>) =>
  database.db
    .select({ kind: jobCreditEntries.kind, units: jobCreditEntries.units })
    .from(jobCreditEntries)
    .all();

const jobValues = (id: string, createdAt: number) => ({
  createdAt,
  declaredBytes: 100,
  id,
  kind: "compress" as const,
  maxUploadBytes: 1_000,
  optionsJson: "{}",
  plan: "free" as const,
  sourceFilename: "input.mp4",
  state: "queued" as const,
  updatedAt: createdAt,
  userId: "user-1",
});
