import { afterEach, expect, it } from "vitest";
import { claimNextJob } from "../src/database/job-repository.ts";
import { transitionJob } from "../src/database/job-transition-repository.ts";
import { jobEvents, jobs } from "../src/database/schema.ts";
import { createJobTestContext, cleanupJobFixtures, queueCanonicalJob } from "./job-fixture.ts";

afterEach(cleanupJobFixtures);
const firstOutput = {
  codec: "vp9",
  filename: "video-vp9.webm",
  index: 1,
  total: 2,
  processedDurationSeconds: 2,
  totalDurationSeconds: 10,
} as const;
const secondOutput = {
  codec: "h265",
  filename: "video-h265.mp4",
  index: 2,
  total: 2,
  processedDurationSeconds: 1,
  totalDurationSeconds: 10,
} as const;
const fence = { workerId: "worker-1", attempt: 1 };

it("records fenced monotonic progress and throttles sub-percent updates", async () => {
  const { database } = await createJobTestContext();
  const job = queueCanonicalJob(database);
  claimNextJob(database, { now: 10, workerId: fence.workerId, leaseDurationMs: 10_000 });
  transitionJob(database, {
    jobId: job.id,
    now: 20,
    command: {
      type: "processing",
      ...fence,
      creditUnits: job.quoteCreditUnits,
      leaseDurationMs: 10_000,
    },
  });
  const command = {
    type: "progress",
    ...fence,
    percent: 25,
    phase: "encoding",
    activeOutputs: [firstOutput],
  } as const;
  const first = transitionJob(database, { jobId: job.id, now: 40, command });
  expect(JSON.parse(first?.progressJson ?? "{}")).toEqual({
    activeOutputs: [firstOutput],
    attempt: 1,
    percent: 25,
    phase: "encoding",
    revision: 4,
  });
  expect(
    transitionJob(database, { jobId: job.id, now: 50, command: { ...command, percent: 20 } }),
  ).toBeUndefined();
  expect(
    transitionJob(database, {
      jobId: job.id,
      now: 50,
      command: {
        ...command,
        percent: 26,
        activeOutputs: [{ ...firstOutput, processedDurationSeconds: 1 }],
      },
    }),
  ).toBeUndefined();
  const changed = transitionJob(database, {
    jobId: job.id,
    now: 100,
    command: { ...command, activeOutputs: [firstOutput, secondOutput] },
  });
  expect(JSON.parse(changed?.progressJson ?? "{}")).toMatchObject({
    activeOutputs: [firstOutput, secondOutput],
    revision: 5,
  });
  const advanced = {
    ...command,
    percent: 25.5,
    activeOutputs: [
      { ...firstOutput, processedDurationSeconds: 3 },
      { ...secondOutput, processedDurationSeconds: 2 },
    ],
  };
  expect(transitionJob(database, { jobId: job.id, now: 500, command: advanced })).toBeUndefined();
  const timed = transitionJob(database, { jobId: job.id, now: 1_100, command: advanced });
  expect(JSON.parse(timed?.progressJson ?? "{}")).toMatchObject({ percent: 25.5, revision: 6 });
  expect(
    transitionJob(database, {
      jobId: job.id,
      now: 2_000,
      command: { ...advanced, attempt: 0, percent: 50 },
    }),
  ).toBeUndefined();
  expect(database.db.select().from(jobs).get()?.progressJson).toBe(timed?.progressJson);
  expect(
    database.db
      .select()
      .from(jobEvents)
      .all()
      .filter(({ kind }) => kind === "progress"),
  ).toHaveLength(3);
});
