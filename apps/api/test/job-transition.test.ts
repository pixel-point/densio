import { expect, it } from "vitest";
import { reduceJobTransition, type JobLifecycle } from "../src/jobs/job-transition.ts";

const preparing: JobLifecycle = {
  state: "preparing",
  revision: 0,
  attemptCount: 0,
  startedAt: null,
  leaseOwner: null,
  leaseExpiresAt: null,
  cancelRequestedAt: null,
  quoteCreditUnits: 25,
  reservedCreditUnits: 25,
  progress: { phase: "preparing", percent: 0, attempt: 0, revision: 0 },
};

it("rejects same-attempt phase regression and malformed per-output progress", () => {
  const processing: JobLifecycle = {
    ...preparing,
    state: "processing",
    attemptCount: 1,
    leaseOwner: "w1",
    leaseExpiresAt: 200,
    progress: { phase: "measuring", percent: 85, attempt: 1, revision: 3 },
  };
  const command = { type: "progress", workerId: "w1", attempt: 1, percent: 86 } as const;
  expect(reduceJobTransition(processing, { ...command, phase: "encoding" }, 100)).toBeUndefined();
  expect(
    reduceJobTransition(
      processing,
      {
        ...command,
        phase: "measuring",
        activeOutputs: [
          { index: -1, total: 2, processedDurationSeconds: 1, totalDurationSeconds: 2 },
        ],
      },
      100,
    ),
  ).toBeUndefined();
});

it("moves only attached inputs to the queue and fences each worker attempt", () => {
  const queued = reduceJobTransition(preparing, { type: "source-attached" }, 100)?.next;
  expect(queued?.state).toBe("queued");
  if (queued === undefined) throw new Error("queue transition missing");
  const claimed = reduceJobTransition(
    queued,
    { type: "claim", workerId: "w1", leaseDurationMs: 100 },
    101,
  )?.next;
  expect(claimed).toMatchObject({ state: "analyzing", attemptCount: 1, revision: 2 });
  if (claimed === undefined) throw new Error("claim transition missing");
  expect(
    reduceJobTransition(
      claimed,
      { type: "processing", workerId: "w1", attempt: 0, creditUnits: 25, leaseDurationMs: 100 },
      102,
    ),
  ).toBeUndefined();
  expect(
    reduceJobTransition(
      claimed,
      { type: "processing", workerId: "w1", attempt: 1, creditUnits: 30, leaseDurationMs: 100 },
      102,
    ),
  ).toMatchObject({
    next: { state: "failed" },
    credit: "release",
    failure: { code: "PLAN_DIVERGED" },
  });
  expect(
    reduceJobTransition(
      claimed,
      { type: "complete", workerId: "w1", attempt: 1, resultJson: "{}" },
      202,
    ),
  ).toBeUndefined();
});

it("requires publication before success and charges only encoded-output limit failures", () => {
  const processing: JobLifecycle = {
    ...preparing,
    state: "processing",
    attemptCount: 1,
    leaseOwner: "w1",
    leaseExpiresAt: 200,
  };
  const fence = { workerId: "w1", attempt: 1 };
  expect(
    reduceJobTransition(processing, { type: "complete", ...fence, resultJson: "{}" }, 100),
  ).toBeUndefined();
  expect(
    reduceJobTransition(
      processing,
      { type: "output-limit-exceeded", ...fence, actualBytes: 20, limitBytes: 10 },
      100,
    ),
  ).toMatchObject({ credit: "settle", next: { state: "failed" } });
  expect(
    reduceJobTransition(
      processing,
      { type: "fail", ...fence, code: "MEDIA_PROCESS_FAILED", details: {}, message: "Failed" },
      100,
    ),
  ).toMatchObject({ credit: "release" });
  const publishing = reduceJobTransition(processing, { type: "publishing", ...fence }, 100)?.next;
  expect(publishing?.state).toBe("publishing");
  if (publishing === undefined) throw new Error("publishing transition missing");
  expect(
    reduceJobTransition(publishing, { type: "complete", ...fence, resultJson: "{}" }, 101),
  ).toMatchObject({ credit: "settle", next: { state: "succeeded", progress: { percent: 100 } } });
});

it("retains monotonic progress through recovery and releases never-started cancellation", () => {
  expect(reduceJobTransition(preparing, { type: "cancel" }, 100)).toMatchObject({
    credit: "release",
    next: { state: "canceled", startedAt: null },
  });
  const interrupted: JobLifecycle = {
    ...preparing,
    state: "processing",
    attemptCount: 1,
    leaseOwner: "w1",
    leaseExpiresAt: 100,
    progress: { percent: 70, phase: "encoding", revision: 3, attempt: 1 },
  };
  expect(reduceJobTransition(interrupted, { type: "recover", maxAttempts: 3 }, 100)).toMatchObject({
    next: { state: "queued", leaseOwner: null, progress: { percent: 70 } },
    attemptOutcome: "interrupted",
  });
});
