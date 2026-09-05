import {
  fixtureOrganizationActor,
  ensureOrganizationActor,
} from "./organization-fixture-identity.ts";
import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import type { Database } from "../src/database/database.ts";
import { claimNextJob, createJob, recoverExpiredJobs } from "../src/database/job-repository.ts";
import { transitionJob } from "../src/database/job-transition-repository.ts";
import { jobCreditEntries, jobs, organizationMemberships } from "../src/database/schema.ts";
import {
  seedJobInput,
  createJobTestContext,
  cleanupJobFixtures,
  queueCanonicalJob,
} from "./job-fixture.ts";

afterEach(cleanupJobFixtures);
const admission = {
  actor: fixtureOrganizationActor,
  now: 1,
  priceIds: { basic: "price_basic", pro: "price_pro", scale: "price_scale" },
};
const fence = { workerId: "worker-1", attempt: 1 };

it("reserves the exact quote before attachment and atomically rejects unaffordable work", async () => {
  const { database } = await createJobTestContext();
  const values = seedJobInput(database, { quoteCreditUnits: 2995 });
  expect(createJob(database, values, admission)).toMatchObject({
    created: true,
    job: { state: "preparing" },
  });
  const second = seedJobInput(database, { id: "second", quoteCreditUnits: 10 });
  expect(createJob(database, second, admission)).toEqual({
    kind: "insufficient-credits",
    availableCredits: 0.05,
  });
  expect(database.db.select().from(jobs).all()).toHaveLength(1);
  expect(entries(database)).toEqual([{ kind: "hold", units: 2995 }]);
});

it("settles completed encoding into append-only release and usage exactly once", async () => {
  const { database } = await createJobTestContext();
  processing(database);
  transitionJob(database, { jobId: "job-1", now: 30, command: { type: "publishing", ...fence } });
  const command = {
    type: "complete",
    ...fence,
    resultJson: '{"kind":"compress","artifactIds":["a"],"html":"<video></video>"}',
  } as const;
  transitionJob(database, { jobId: "job-1", now: 40, command });
  transitionJob(database, { jobId: "job-1", now: 41, command });
  expect(entries(database)).toEqual([
    { kind: "hold", units: 45 },
    { kind: "release", units: 45 },
    { kind: "usage", units: 45 },
  ]);
});

it("settles against the original organization and UTC month after creator removal", async () => {
  const { database } = await createJobTestContext();
  processing(database);
  ensureOrganizationActor(database, "org-2", "user-1");
  database.db
    .delete(organizationMemberships)
    .where(eq(organizationMemberships.id, fixtureOrganizationActor.membershipId))
    .run();
  const now = Date.UTC(1970, 1, 1);
  transitionJob(database, {
    jobId: "job-1",
    now: 21,
    command: {
      type: "lease",
      ...fence,
      leaseDurationMs: now + 100,
    },
  });
  transitionJob(database, { jobId: "job-1", now, command: { type: "publishing", ...fence } });
  transitionJob(database, {
    jobId: "job-1",
    now: now + 1,
    command: {
      type: "complete",
      ...fence,
      resultJson: '{"kind":"compress","artifactIds":["a"],"html":"<video></video>"}',
    },
  });
  expect(
    database.db
      .select({
        organizationId: jobCreditEntries.organizationId,
        periodStart: jobCreditEntries.periodStart,
        kind: jobCreditEntries.kind,
        units: jobCreditEntries.units,
      })
      .from(jobCreditEntries)
      .all(),
  ).toEqual([
    { organizationId: "org-1", periodStart: 0, kind: "hold", units: 45 },
    { organizationId: "org-1", periodStart: 0, kind: "release", units: 45 },
    { organizationId: "org-1", periodStart: 0, kind: "usage", units: 45 },
  ]);
});

it("admits only one teammate against the final shared credits", async () => {
  const { database } = await createJobTestContext();
  const teammate = ensureOrganizationActor(database, "org-1", "teammate");
  const values = [
    seedJobInput(database, { id: "first", quoteCreditUnits: 3000 }),
    seedJobInput(database, {
      id: "second",
      createdByUserId: "teammate",
      quoteCreditUnits: 3000,
    }),
  ];
  const results = await Promise.all(
    values.map((value, index) =>
      Promise.resolve().then(() =>
        createJob(database, value, {
          ...admission,
          actor: index === 0 ? fixtureOrganizationActor : teammate,
        }),
      ),
    ),
  );
  expect(results.filter((result) => result.kind === "insufficient-credits")).toHaveLength(1);
  expect(entries(database)).toEqual([{ kind: "hold", units: 3000 }]);
});

it.each(["failure", "output-limit"] as const)(
  "applies the correct billing disposition for %s",
  async (kind) => {
    const { database } = await createJobTestContext();
    processing(database);
    transitionJob(database, {
      jobId: "job-1",
      now: 30,
      command:
        kind === "failure"
          ? { type: "fail", ...fence, code: "BAD_MEDIA", message: "Invalid media", details: {} }
          : { type: "output-limit-exceeded", ...fence, actualBytes: 101, limitBytes: 100 },
    });
    expect(entries(database)).toEqual([
      { kind: "hold", units: 45 },
      { kind: "release", units: 45 },
      ...(kind === "output-limit" ? [{ kind: "usage", units: 45 }] : []),
    ]);
  },
);

it("does not top up a quote during analysis when cost diverges", async () => {
  const { database } = await createJobTestContext();
  queueCanonicalJob(database, { quoteCreditUnits: 45 });
  claimNextJob(database, { now: 10, workerId: fence.workerId, leaseDurationMs: 100 });
  expect(
    transitionJob(database, {
      jobId: "job-1",
      now: 20,
      command: { type: "processing", ...fence, creditUnits: 46, leaseDurationMs: 100 },
    }),
  ).toMatchObject({ state: "failed", errorCode: "PLAN_DIVERGED" });
  expect(entries(database)).toEqual([
    { kind: "hold", units: 45 },
    { kind: "release", units: 45 },
  ]);
});

it("refuses to process when the durable hold is missing", async () => {
  const { database } = await createJobTestContext();
  queueCanonicalJob(database, { quoteCreditUnits: 45 });
  database.db.delete(jobCreditEntries).where(eq(jobCreditEntries.jobId, "job-1")).run();
  claimNextJob(database, { now: 10, workerId: fence.workerId, leaseDurationMs: 100 });
  expect(
    transitionJob(database, {
      jobId: "job-1",
      now: 20,
      command: { type: "processing", ...fence, creditUnits: 45, leaseDurationMs: 100 },
    }),
  ).toMatchObject({ state: "failed", errorCode: "JOB_CREDIT_RESERVATION_MISSING" });
  expect(entries(database)).toEqual([]);
});

it.each(["queued", "active"] as const)(
  "releases the entire quote on %s cancellation",
  async (state) => {
    const { database } = await createJobTestContext();
    queueCanonicalJob(database, { quoteCreditUnits: 45 });
    if (state === "active")
      claimNextJob(database, { now: 10, workerId: fence.workerId, leaseDurationMs: 100 });
    transitionJob(database, { jobId: "job-1", now: 20, command: { type: "cancel" } });
    if (state === "active")
      transitionJob(database, {
        jobId: "job-1",
        now: 21,
        command: { type: "confirm-canceled", ...fence },
      });
    expect(entries(database)).toEqual([
      { kind: "hold", units: 45 },
      { kind: "release", units: 45 },
    ]);
  },
);

it("retains the quote across a retry and releases it on exhausted attempts", async () => {
  const { database } = await createJobTestContext();
  processing(database);
  recoverExpiredJobs(database, { now: 120, maxAttempts: 2 });
  expect(entries(database)).toEqual([{ kind: "hold", units: 45 }]);
  claimNextJob(database, { now: 130, workerId: fence.workerId, leaseDurationMs: 100 });
  recoverExpiredJobs(database, { now: 230, maxAttempts: 2 });
  expect(entries(database)).toEqual([
    { kind: "hold", units: 45 },
    { kind: "release", units: 45 },
  ]);
});

it("ignores released and previous-period holds when admitting new work", async () => {
  const { database } = await createJobTestContext();
  const values = seedJobInput(database, { quoteCreditUnits: 3000 });
  createJob(database, values, admission);
  transitionJob(database, { jobId: "job-1", now: 20, command: { type: "cancel" } });
  const next = seedJobInput(database, { id: "next", quoteCreditUnits: 3000 });
  expect(createJob(database, next, admission)).toMatchObject({
    created: true,
  });
  const nextPeriod = seedJobInput(database, { id: "next-period", quoteCreditUnits: 3000 });
  expect(
    createJob(database, nextPeriod, { ...admission, now: Date.UTC(1970, 1, 1) }),
  ).toMatchObject({ created: true });
});

const processing = (database: Database) => {
  queueCanonicalJob(database, { quoteCreditUnits: 45 });
  claimNextJob(database, { now: 10, workerId: fence.workerId, leaseDurationMs: 100 });
  return transitionJob(database, {
    jobId: "job-1",
    now: 20,
    command: { type: "processing", ...fence, creditUnits: 45, leaseDurationMs: 100 },
  });
};

const entries = (database: Database) =>
  database.db
    .select({ kind: jobCreditEntries.kind, units: jobCreditEntries.units })
    .from(jobCreditEntries)
    .all();
