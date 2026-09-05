import {
  JobProgressSchema,
  type JobActiveOutput,
  type JobEventKind,
  type JobProgress,
  type JobState,
} from "@densio/shared";
import { Schema } from "effect";

export interface JobLifecycle {
  readonly state: JobState;
  readonly revision: number;
  readonly attemptCount: number;
  readonly startedAt: number | null;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: number | null;
  readonly cancelRequestedAt: number | null;
  readonly quoteCreditUnits: number;
  readonly reservedCreditUnits: number;
  readonly progress: JobProgress;
}

export interface WorkerFence {
  readonly workerId: string;
  readonly attempt: number;
}

interface Failure {
  readonly code: string;
  readonly details: Schema.Json;
  readonly message: string;
}

export type JobTransitionCommand =
  | { readonly type: "source-attached" | "attachment-failed" | "cancel" }
  | { readonly type: "claim"; readonly workerId: string; readonly leaseDurationMs: number }
  | { readonly type: "recover"; readonly maxAttempts: number }
  | (WorkerFence &
      (
        | { readonly type: "confirm-canceled" | "publishing" | "artifact-published" }
        | { readonly type: "lease"; readonly leaseDurationMs: number }
        | {
            readonly type: "processing";
            readonly creditUnits: number;
            readonly leaseDurationMs: number;
          }
        | { readonly type: "provenance"; readonly toolchainJson: string }
        | {
            readonly type: "progress";
            readonly percent: number;
            readonly phase: JobProgress["phase"];
            readonly activeOutputs?: ReadonlyArray<JobActiveOutput>;
          }
        | { readonly type: "complete"; readonly resultJson: string }
        | ({ readonly type: "fail" } & Failure)
        | {
            readonly type: "output-limit-exceeded";
            readonly actualBytes: number;
            readonly limitBytes: number;
          }
      ));

export interface JobTransition {
  readonly next: JobLifecycle;
  readonly event?: JobEventKind;
  readonly credit?: "release" | "settle";
  readonly attemptOutcome?: "running" | "succeeded" | "failed" | "interrupted";
  readonly completedAt?: number;
  readonly failure?: Failure;
  readonly resultJson?: string;
  readonly toolchainJson?: string;
}

export const isTerminalJob = (state: JobState) =>
  state === "succeeded" || state === "failed" || state === "canceled";

export const reduceJobTransition = (
  job: JobLifecycle,
  command: JobTransitionCommand,
  now: number,
): JobTransition | undefined => {
  if (isTerminalJob(job.state)) return undefined;
  if ("attempt" in command && !ownsLease(job, command, now)) return undefined;
  if (
    job.cancelRequestedAt !== null &&
    "attempt" in command &&
    command.type !== "confirm-canceled" &&
    command.type !== "lease"
  )
    return undefined;
  switch (command.type) {
    case "source-attached":
      return job.state === "preparing" ? change(job, "queued", "queued", 2) : undefined;
    case "attachment-failed":
      return job.state === "preparing"
        ? fail(job, now, {
            code: "PREPARED_SOURCE_UNAVAILABLE",
            message: "The source could not be attached to this job.",
            details: {},
          })
        : undefined;
    case "claim":
      return job.state === "queued" ? claim(job, command, now) : undefined;
    case "cancel":
      return job.state === "preparing" || job.state === "queued"
        ? terminal(job, "canceled", now, "release")
        : {
            next: {
              ...job,
              cancelRequestedAt: job.cancelRequestedAt ?? now,
              revision: job.revision + 1,
            },
          };
    case "confirm-canceled":
      return job.cancelRequestedAt === null ? undefined : terminal(job, "canceled", now, "release");
    case "lease":
      return {
        next: { ...job, leaseExpiresAt: now + command.leaseDurationMs, revision: job.revision + 1 },
      };
    case "processing":
      return startProcessing(job, command, now);
    case "provenance":
      return job.state === "analyzing"
        ? { next: { ...job, revision: job.revision + 1 }, toolchainJson: command.toolchainJson }
        : undefined;
    case "progress":
      return advanceProgress(job, command);
    case "publishing":
      return job.state === "processing" ? change(job, "publishing", "publishing", 96) : undefined;
    case "artifact-published":
      return job.state === "publishing"
        ? { next: { ...job, revision: job.revision + 1 }, event: "artifact-published" }
        : undefined;
    case "complete":
      return job.state === "publishing"
        ? { ...terminal(job, "succeeded", now, "settle"), resultJson: command.resultJson }
        : undefined;
    case "fail":
      return fail(job, now, command);
    case "output-limit-exceeded":
      return job.state === "processing" || job.state === "publishing"
        ? {
            ...terminal(job, "failed", now, "settle"),
            failure: {
              code: "OUTPUT_SIZE_LIMIT_EXCEEDED",
              message: "The encoded outputs exceed the configured byte limit.",
              details: { actualBytes: command.actualBytes, limitBytes: command.limitBytes },
            },
          }
        : undefined;
    case "recover":
      return recover(job, command.maxAttempts, now);
  }
};

const ownsLease = (job: JobLifecycle, fence: WorkerFence, now: number) =>
  (job.state === "analyzing" || job.state === "processing" || job.state === "publishing") &&
  job.leaseOwner === fence.workerId &&
  job.attemptCount === fence.attempt &&
  job.leaseExpiresAt !== null &&
  job.leaseExpiresAt > now;

const change = (
  job: JobLifecycle,
  state: JobState,
  phase: JobProgress["phase"],
  percent: number,
): JobTransition => ({
  event: "state-changed",
  next: {
    ...job,
    state,
    revision: job.revision + 1,
    progress: {
      attempt: job.attemptCount,
      phase,
      percent: Math.max(job.progress.percent, percent),
      revision: job.revision + 1,
    },
  },
});

const claim = (
  job: JobLifecycle,
  command: { readonly workerId: string; readonly leaseDurationMs: number },
  now: number,
): JobTransition => {
  const transition = change(
    { ...job, attemptCount: job.attemptCount + 1 },
    "analyzing",
    "inspecting",
    5,
  );
  return {
    ...transition,
    attemptOutcome: "running",
    next: {
      ...transition.next,
      leaseOwner: command.workerId,
      leaseExpiresAt: now + command.leaseDurationMs,
      startedAt: job.startedAt ?? now,
    },
  };
};

const terminal = (
  job: JobLifecycle,
  state: "succeeded" | "failed" | "canceled",
  now: number,
  credit: "release" | "settle",
): JobTransition => {
  const transition = change(
    job,
    state,
    state === "succeeded" ? "complete" : state,
    state === "succeeded" ? 100 : job.progress.percent,
  );
  return {
    ...transition,
    event: "terminal",
    credit,
    completedAt: now,
    attemptOutcome: state === "canceled" ? "interrupted" : state,
    next: { ...transition.next, leaseOwner: null, leaseExpiresAt: null },
  };
};

const fail = (job: JobLifecycle, now: number, failure: Failure): JobTransition => ({
  ...terminal(job, "failed", now, "release"),
  failure,
});

const recover = (
  job: JobLifecycle,
  maxAttempts: number,
  now: number,
): JobTransition | undefined => {
  if (job.leaseExpiresAt === null || job.leaseExpiresAt > now || job.leaseOwner === null)
    return undefined;
  if (job.cancelRequestedAt !== null) return terminal(job, "canceled", now, "release");
  if (job.attemptCount >= maxAttempts)
    return {
      ...fail(job, now, {
        code: "JOB_ATTEMPTS_EXHAUSTED",
        message: "The job exceeded its recovery attempts.",
        details: {},
      }),
      attemptOutcome: "interrupted",
    };
  const transition = change(job, "queued", "queued", 2);
  return {
    ...transition,
    attemptOutcome: "interrupted",
    next: { ...transition.next, leaseOwner: null, leaseExpiresAt: null },
  };
};

const advanceProgress = (
  job: JobLifecycle,
  command: Extract<JobTransitionCommand, { readonly type: "progress" }>,
): JobTransition | undefined => {
  if (job.state !== "processing" || !["preparing", "encoding", "measuring"].includes(command.phase))
    return undefined;
  const phases = ["preparing", "encoding", "measuring"];
  if (phases.indexOf(command.phase) < phases.indexOf(job.progress.phase)) return undefined;
  if (
    !Number.isFinite(command.percent) ||
    command.percent < job.progress.percent ||
    command.percent >= 100
  )
    return undefined;
  if (
    command.phase === job.progress.phase &&
    command.activeOutputs?.some((output) => {
      const previous = job.progress.activeOutputs?.find(
        (candidate) =>
          candidate.index === output.index &&
          candidate.variantId === output.variantId &&
          candidate.filename === output.filename,
      );
      return (
        previous !== undefined &&
        previous.processedDurationSeconds > output.processedDurationSeconds
      );
    })
  )
    return undefined;
  const progress = {
    attempt: job.attemptCount,
    percent: command.percent,
    phase: command.phase,
    revision: job.revision + 1,
    ...(command.activeOutputs === undefined ? {} : { activeOutputs: [...command.activeOutputs] }),
  };
  if (!Schema.is(JobProgressSchema)(progress)) return undefined;
  return { event: "progress", next: { ...job, revision: job.revision + 1, progress } };
};

const startProcessing = (
  job: JobLifecycle,
  command: Extract<JobTransitionCommand, { readonly type: "processing" }>,
  now: number,
): JobTransition | undefined => {
  if (job.state !== "analyzing") return undefined;
  if (job.reservedCreditUnits !== job.quoteCreditUnits)
    return fail(job, now, {
      code: "JOB_CREDIT_RESERVATION_MISSING",
      message: "The exact credit reservation is missing.",
      details: {},
    });
  if (command.creditUnits !== job.quoteCreditUnits)
    return fail(job, now, {
      code: "PLAN_DIVERGED",
      message: "The analyzed cost differs from the immutable quote.",
      details: {
        analyzedCreditUnits: command.creditUnits,
        quotedCreditUnits: job.quoteCreditUnits,
      },
    });
  const transition = change(job, "processing", "preparing", 10);
  return {
    ...transition,
    next: {
      ...transition.next,
      leaseExpiresAt: now + command.leaseDurationMs,
    },
  };
};
