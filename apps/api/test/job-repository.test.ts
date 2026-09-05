import {
  ensureOrganizationActor,
  fixtureOrganizationActor,
} from "./organization-fixture-identity.ts";
import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import {
  claimNextJob,
  createJob,
  isJobCancellationRequested,
  recoverExpiredJobs,
} from "../src/database/job-repository.ts";
import { transitionJob, cancelOrganizationJob } from "../src/database/job-transition-repository.ts";
import { jobAttempts, jobCreditEntries, jobEvents, jobs } from "../src/database/schema.ts";
import {
  seedJobInput,
  createJobTestContext,
  cleanupJobFixtures,
  queueCanonicalJob,
  seedCanonicalJob,
} from "./job-fixture.ts";

afterEach(cleanupJobFixtures);
const admission = {
  actor: fixtureOrganizationActor,
  now: 1,
  priceIds: { basic: "price_basic", pro: "price_pro", scale: "price_scale" },
};
const fence = { workerId: "worker-1", attempt: 1 };

it("claims paid work first, then oldest queued work, with exclusive attempt leases", async () => {
  const { database } = await createJobTestContext();
  queueCanonicalJob(database, { id: "new", createdAt: 20 });
  queueCanonicalJob(database, { id: "old", createdAt: 10 });
  queueCanonicalJob(database, { id: "paid", createdAt: 30, subscriptionPlan: "basic" });
  const claim = (now: number) =>
    claimNextJob(database, { now, workerId: "worker-1", leaseDurationMs: 100 });
  expect(claim(100)).toMatchObject({
    id: "paid",
    state: "analyzing",
    attemptCount: 1,
    leaseOwner: "worker-1",
    leaseExpiresAt: 200,
  });
  expect(claim(101)?.id).toBe("old");
  expect(claim(102)?.id).toBe("new");
  expect(claim(103)).toBeUndefined();
  expect(database.db.select().from(jobAttempts).all()).toHaveLength(3);
});

it("atomically creates one job, exact hold, and event per owner/key/digest", async () => {
  const { database } = await createJobTestContext();
  const values = seedJobInput(database, { quoteCreditUnits: 25, idempotencyKey: "same-key" });
  const policy = admission;
  expect(createJob(database, values, policy)).toMatchObject({
    created: true,
    job: { state: "preparing" },
  });
  expect(createJob(database, { ...values, id: "retry" }, policy)).toMatchObject({
    created: false,
    job: { id: values.id },
  });
  expect(createJob(database, { ...values, requestDigest: "b".repeat(64) }, policy)).toEqual({
    kind: "idempotency-conflict",
  });
  expect(database.db.select().from(jobs).all()).toHaveLength(1);
  expect(database.db.select().from(jobCreditEntries).all()).toMatchObject([
    { kind: "hold", units: 25 },
  ]);
  expect(database.db.select().from(jobEvents).all()).toMatchObject([
    { kind: "created", state: "preparing" },
  ]);
});

it("keeps recovery references unique per owner without consuming a second hold", async () => {
  const { database } = await createJobTestContext();
  seedCanonicalJob(database, { id: "first", clientReference: "hero" });
  const values = seedJobInput(database, { id: "second", clientReference: "hero" });
  expect(createJob(database, values, admission)).toEqual({
    kind: "client-reference-conflict",
  });
  expect(
    seedCanonicalJob(database, {
      id: "other",
      organizationId: "org-2",
      createdByUserId: "user-2",
      clientReference: "hero",
    }).id,
  ).toBe("other");
  expect(database.db.select().from(jobCreditEntries).all()).toHaveLength(2);
});

it("fences every visible mutation by owner, live lease, attempt, and current row revision", async () => {
  const { database } = await createJobTestContext();
  queueCanonicalJob(database);
  const claimed = claimNextJob(database, {
    now: 10,
    workerId: fence.workerId,
    leaseDurationMs: 100,
  });
  if (claimed === undefined) throw new Error("Expected a claimed job");
  const command = {
    type: "processing",
    ...fence,
    creditUnits: claimed?.quoteCreditUnits ?? 0,
    leaseDurationMs: 100,
  } as const;
  expect(
    transitionJob(database, { jobId: "job-1", now: 20, expectedRevision: 0, command }),
  ).toBeUndefined();
  expect(
    transitionJob(database, { jobId: "job-1", now: 20, command: { ...command, attempt: 0 } }),
  ).toBeUndefined();
  expect(
    transitionJob(database, {
      jobId: "job-1",
      now: 20,
      command: { ...command, workerId: "foreign" },
    }),
  ).toBeUndefined();
  expect(transitionJob(database, { jobId: "job-1", now: 111, command })).toBeUndefined();
  expect(
    transitionJob(database, {
      jobId: "job-1",
      now: 20,
      expectedRevision: claimed.revision,
      command,
    }),
  ).toMatchObject({ state: "processing" });
});

it("publishes and completes once, atomically freezing evidence and closing the attempt", async () => {
  const { database } = await createJobTestContext();
  const queued = queueCanonicalJob(database, { quoteCreditUnits: 25 });
  claimNextJob(database, { now: 10, workerId: fence.workerId, leaseDurationMs: 100 });
  transitionJob(database, {
    jobId: queued.id,
    now: 15,
    command: {
      type: "provenance",
      ...fence,
      toolchainJson: '{"ffmpegVersion":"actual","ffprobeVersion":"actual"}',
    },
  });
  transitionJob(database, {
    jobId: queued.id,
    now: 20,
    command: { type: "processing", ...fence, creditUnits: 25, leaseDurationMs: 100 },
  });
  const resultJson = JSON.stringify({
    kind: "compress",
    artifactIds: ["artifact-1"],
    html: "<video></video>",
  });
  expect(
    transitionJob(database, {
      jobId: queued.id,
      now: 21,
      command: { type: "complete", ...fence, resultJson },
    }),
  ).toBeUndefined();
  transitionJob(database, { jobId: queued.id, now: 22, command: { type: "publishing", ...fence } });
  const completed = transitionJob(database, {
    jobId: queued.id,
    now: 23,
    command: { type: "complete", ...fence, resultJson },
  });
  expect(completed).toMatchObject({ state: "succeeded", leaseOwner: null });
  expect(JSON.parse(completed?.receiptJson ?? "{}")).toMatchObject({
    intent: { sourceId: queued.sourceId, executionPlanId: queued.executionPlanId },
    execution: { attempts: 1, ffmpegVersion: "actual", commands: [] },
    billing: { actualCreditUnits: 25, actualCredits: 0.25 },
  });
  expect(
    transitionJob(database, {
      jobId: queued.id,
      now: 24,
      command: { type: "complete", ...fence, resultJson },
    }),
  ).toBeUndefined();
  expect(database.db.select().from(jobAttempts).get()).toMatchObject({
    outcome: "succeeded",
    completedAt: 23,
  });
  expect(
    database.db
      .select({ kind: jobEvents.kind })
      .from(jobEvents)
      .all()
      .map(({ kind }) => kind),
  ).toEqual([
    "created",
    "state-changed",
    "state-changed",
    "state-changed",
    "state-changed",
    "terminal",
  ]);
});

it("cancels queued work immediately and active work cooperatively", async () => {
  const { database } = await createJobTestContext();
  queueCanonicalJob(database);
  expect(
    cancelOrganizationJob(database, {
      jobId: "job-1",
      actor: ensureOrganizationActor(database, "org-2", "user-2"),
      now: 3,
    }),
  ).toBeUndefined();
  claimNextJob(database, { now: 10, workerId: fence.workerId, leaseDurationMs: 100 });
  expect(
    cancelOrganizationJob(database, {
      jobId: "job-1",
      actor: fixtureOrganizationActor,
      now: 20,
    }),
  ).toMatchObject({ state: "analyzing", cancelRequestedAt: 20 });
  expect(isJobCancellationRequested(database, "job-1", fence.workerId, 1)).toBe(true);
  expect(isJobCancellationRequested(database, "job-1", fence.workerId, 0)).toBe(false);
  expect(
    transitionJob(database, {
      jobId: "job-1",
      now: 21,
      command: { type: "confirm-canceled", ...fence },
    }),
  ).toMatchObject({ state: "canceled" });
  expect(database.db.select().from(jobAttempts).get()).toMatchObject({ outcome: "interrupted" });
  seedCanonicalJob(database, { id: "never-started" });
  const canceled = transitionJob(database, {
    jobId: "never-started",
    now: 22,
    command: { type: "cancel" },
  });
  expect(JSON.parse(canceled?.receiptJson ?? "{}").execution).toEqual({
    attempts: 0,
    completedAt: new Date(22).toISOString(),
    commands: [],
  });
});

it("recovers interrupted leases without allowing an old same-worker attempt to alter new work", async () => {
  const { database } = await createJobTestContext();
  queueCanonicalJob(database);
  claimNextJob(database, { now: 10, workerId: fence.workerId, leaseDurationMs: 100 });
  expect(recoverExpiredJobs(database, { now: 110, maxAttempts: 2 })).toEqual({
    canceled: [],
    failed: [],
    requeued: ["job-1"],
  });
  expect(
    claimNextJob(database, { now: 111, workerId: fence.workerId, leaseDurationMs: 100 }),
  ).toMatchObject({ attemptCount: 2 });
  expect(
    transitionJob(database, {
      jobId: "job-1",
      now: 112,
      command: { type: "fail", ...fence, code: "STALE", message: "stale", details: {} },
    }),
  ).toBeUndefined();
  expect(recoverExpiredJobs(database, { now: 211, maxAttempts: 2 })).toEqual({
    canceled: [],
    failed: ["job-1"],
    requeued: [],
  });
  expect(database.db.select().from(jobs).get()).toMatchObject({
    state: "failed",
    errorCode: "JOB_ATTEMPTS_EXHAUSTED",
  });
});

it("renews only a current live lease without emitting a progress event", async () => {
  const { database } = await createJobTestContext();
  queueCanonicalJob(database);
  claimNextJob(database, { now: 10, workerId: fence.workerId, leaseDurationMs: 100 });
  const before = database.db.select().from(jobEvents).all().length;
  expect(
    transitionJob(database, {
      jobId: "job-1",
      now: 20,
      command: { type: "lease", ...fence, leaseDurationMs: 100 },
    }),
  ).toMatchObject({ leaseExpiresAt: 120 });
  expect(
    transitionJob(database, {
      jobId: "job-1",
      now: 120,
      command: { type: "lease", ...fence, leaseDurationMs: 100 },
    }),
  ).toBeUndefined();
  expect(database.db.select().from(jobEvents).all()).toHaveLength(before);
  expect(database.db.select().from(jobs).where(eq(jobs.id, "job-1")).get()?.revision).toBe(3);
});
