import { afterEach, expect, it } from "vitest";
import { claimNextJob } from "../src/database/job-repository.ts";
import { transitionJob } from "../src/database/job-transition-repository.ts";
import { jobs } from "../src/database/schema.ts";
import { createJobTestContext, cleanupJobFixtures, queueCanonicalJob } from "./job-fixture.ts";

afterEach(cleanupJobFixtures);

it("records actual tool observations without mutating planned inspection and fences stale attempts", async () => {
  const { database } = await createJobTestContext();
  const job = queueCanonicalJob(database);
  claimNextJob(database, { now: 10, workerId: "worker-1", leaseDurationMs: 100 });
  const command = {
    type: "provenance",
    workerId: "worker-1",
    attempt: 1,
    toolchainJson: '{"ffmpegVersion":"actual","ffprobeVersion":"actual"}',
  } as const;
  expect(transitionJob(database, { jobId: job.id, now: 20, command })).toMatchObject({
    inspectionJson: job.inspectionJson,
    toolchainJson: command.toolchainJson,
  });
  expect(
    transitionJob(database, { jobId: job.id, now: 21, command: { ...command, attempt: 0 } }),
  ).toBeUndefined();
  expect(
    transitionJob(database, { jobId: job.id, now: 21, command: { ...command, workerId: "old" } }),
  ).toBeUndefined();
  expect(transitionJob(database, { jobId: job.id, now: 110, command })).toBeUndefined();
  expect(database.db.select().from(jobs).get()).toMatchObject({
    inspectionJson: job.inspectionJson,
    toolchainJson: command.toolchainJson,
  });
});
