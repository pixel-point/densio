import { randomUUID } from "node:crypto";

import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";

import type { Database } from "./database.ts";
import { jobAttempts, jobs } from "./schema.ts";

interface ClaimJobOptions {
  readonly leaseDurationMs: number;
  readonly now: number;
  readonly workerId: string;
}

interface WorkerTransitionOptions {
  readonly jobId: string;
  readonly leaseDurationMs: number;
  readonly now: number;
  readonly workerId: string;
}

interface CompleteJobOptions {
  readonly jobId: string;
  readonly now: number;
  readonly resultJson: string;
  readonly workerId: string;
}

interface RecoveryOptions {
  readonly maxAttempts: number;
  readonly now: number;
}

interface FailJobOptions {
  readonly errorCode: string;
  readonly errorJson: string;
  readonly jobId: string;
  readonly now: number;
  readonly workerId: string;
}

export const createJob = (database: Database, values: typeof jobs.$inferInsert) =>
  database.db.transaction(
    (transaction) => {
      const existing =
        values.idempotencyKey === null || values.idempotencyKey === undefined
          ? undefined
          : transaction
              .select()
              .from(jobs)
              .where(
                and(eq(jobs.userId, values.userId), eq(jobs.idempotencyKey, values.idempotencyKey)),
              )
              .get();

      if (existing !== undefined) return { created: false as const, job: existing };

      const job = transaction.insert(jobs).values(values).returning().get();
      return { created: true as const, job };
    },
    { behavior: "immediate" },
  );

export const claimNextJob = (
  { db }: Database,
  { leaseDurationMs, now, workerId }: ClaimJobOptions,
) =>
  db.transaction(
    (transaction) => {
      const candidate = transaction
        .select()
        .from(jobs)
        .where(eq(jobs.state, "queued"))
        .orderBy(asc(jobs.createdAt))
        .limit(1)
        .get();

      if (candidate === undefined) return undefined;

      const claimed = transaction
        .update(jobs)
        .set({
          attemptCount: sql`${jobs.attemptCount} + 1`,
          leaseExpiresAt: now + leaseDurationMs,
          leaseOwner: workerId,
          startedAt: candidate.startedAt ?? now,
          state: "analyzing",
          updatedAt: now,
        })
        .where(eq(jobs.id, candidate.id))
        .returning()
        .get();

      if (claimed === undefined) return undefined;

      transaction
        .insert(jobAttempts)
        .values({
          attempt: claimed.attemptCount,
          id: randomUUID(),
          jobId: claimed.id,
          outcome: "running",
          startedAt: now,
          workerId,
        })
        .run();

      return claimed;
    },
    { behavior: "immediate" },
  );

export const requestJobCancellation = (
  database: Database,
  jobId: string,
  userId: string,
  now: number,
) =>
  database.db.transaction(
    (transaction) => {
      const job = transaction
        .select()
        .from(jobs)
        .where(and(eq(jobs.id, jobId), eq(jobs.userId, userId)))
        .get();

      if (job === undefined) return undefined;
      if (["succeeded", "failed", "canceled", "expired"].includes(job.state)) return job;

      if (job.state === "awaiting-upload" || job.state === "queued") {
        return transaction
          .update(jobs)
          .set({ completedAt: now, state: "canceled", updatedAt: now })
          .where(eq(jobs.id, job.id))
          .returning()
          .get();
      }

      return transaction
        .update(jobs)
        .set({ cancelRequestedAt: now, updatedAt: now })
        .where(eq(jobs.id, job.id))
        .returning()
        .get();
    },
    { behavior: "immediate" },
  );

export const isJobCancellationRequested = ({ db }: Database, jobId: string, workerId: string) => {
  const job = db
    .select({ cancelRequestedAt: jobs.cancelRequestedAt })
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.leaseOwner, workerId)))
    .get();

  return job?.cancelRequestedAt !== null && job?.cancelRequestedAt !== undefined;
};

export const markJobProcessing = (
  { db }: Database,
  { jobId, leaseDurationMs, now, workerId }: WorkerTransitionOptions,
) =>
  db
    .update(jobs)
    .set({
      leaseExpiresAt: now + leaseDurationMs,
      progress: 10,
      state: "processing",
      updatedAt: now,
    })
    .where(
      and(
        eq(jobs.id, jobId),
        eq(jobs.state, "analyzing"),
        eq(jobs.leaseOwner, workerId),
        gt(jobs.leaseExpiresAt, now),
        isNull(jobs.cancelRequestedAt),
      ),
    )
    .returning()
    .get();

export const renewJobLease = (
  { db }: Database,
  { jobId, leaseDurationMs, now, workerId }: WorkerTransitionOptions,
) =>
  db
    .update(jobs)
    .set({ leaseExpiresAt: now + leaseDurationMs, updatedAt: now })
    .where(
      and(
        eq(jobs.id, jobId),
        inArray(jobs.state, ["analyzing", "processing"]),
        eq(jobs.leaseOwner, workerId),
        gt(jobs.leaseExpiresAt, now),
      ),
    )
    .returning()
    .get();

export const cancelClaimedJob = (
  database: Database,
  { jobId, now, workerId }: Omit<WorkerTransitionOptions, "leaseDurationMs">,
) =>
  database.db.transaction(
    (transaction) => {
      const canceled = transaction
        .update(jobs)
        .set({
          completedAt: now,
          leaseExpiresAt: null,
          leaseOwner: null,
          state: "canceled",
          updatedAt: now,
        })
        .where(
          and(
            eq(jobs.id, jobId),
            inArray(jobs.state, ["analyzing", "processing"]),
            eq(jobs.leaseOwner, workerId),
            isNotNull(jobs.cancelRequestedAt),
          ),
        )
        .returning()
        .get();

      if (canceled === undefined) return undefined;

      transaction
        .update(jobAttempts)
        .set({ completedAt: now, outcome: "interrupted" })
        .where(
          and(
            eq(jobAttempts.jobId, canceled.id),
            eq(jobAttempts.attempt, canceled.attemptCount),
            eq(jobAttempts.outcome, "running"),
          ),
        )
        .run();

      return canceled;
    },
    { behavior: "immediate" },
  );

export const completeJob = (
  database: Database,
  { jobId, now, resultJson, workerId }: CompleteJobOptions,
) =>
  database.db.transaction(
    (transaction) => {
      const completed = transaction
        .update(jobs)
        .set({
          completedAt: now,
          leaseExpiresAt: null,
          leaseOwner: null,
          progress: 100,
          resultJson,
          state: "succeeded",
          updatedAt: now,
        })
        .where(
          and(
            eq(jobs.id, jobId),
            eq(jobs.state, "processing"),
            eq(jobs.leaseOwner, workerId),
            isNull(jobs.cancelRequestedAt),
          ),
        )
        .returning()
        .get();

      if (completed === undefined) return undefined;

      transaction
        .update(jobAttempts)
        .set({ completedAt: now, outcome: "succeeded" })
        .where(
          and(
            eq(jobAttempts.jobId, completed.id),
            eq(jobAttempts.attempt, completed.attemptCount),
            eq(jobAttempts.outcome, "running"),
          ),
        )
        .run();

      return completed;
    },
    { behavior: "immediate" },
  );

export const recoverExpiredJobs = (database: Database, { maxAttempts, now }: RecoveryOptions) =>
  database.db.transaction(
    (transaction) => {
      const expired = transaction
        .select()
        .from(jobs)
        .where(and(inArray(jobs.state, ["analyzing", "processing"]), lte(jobs.leaseExpiresAt, now)))
        .orderBy(asc(jobs.createdAt))
        .all();

      const outcomes = expired.map((job) => {
        transaction
          .update(jobAttempts)
          .set({ completedAt: now, outcome: "interrupted" })
          .where(
            and(
              eq(jobAttempts.jobId, job.id),
              eq(jobAttempts.attempt, job.attemptCount),
              eq(jobAttempts.outcome, "running"),
            ),
          )
          .run();

        if (job.cancelRequestedAt !== null) {
          transaction
            .update(jobs)
            .set({
              completedAt: now,
              leaseExpiresAt: null,
              leaseOwner: null,
              state: "canceled",
              updatedAt: now,
            })
            .where(eq(jobs.id, job.id))
            .run();
          return { id: job.id, outcome: "canceled" as const };
        }

        if (job.attemptCount >= maxAttempts) {
          transaction
            .update(jobs)
            .set({
              completedAt: now,
              errorCode: "JOB_ATTEMPTS_EXHAUSTED",
              errorJson: JSON.stringify({ message: "The job exceeded its recovery attempts." }),
              leaseExpiresAt: null,
              leaseOwner: null,
              state: "failed",
              updatedAt: now,
            })
            .where(eq(jobs.id, job.id))
            .run();
          return { id: job.id, outcome: "failed" as const };
        }

        transaction
          .update(jobs)
          .set({
            leaseExpiresAt: null,
            leaseOwner: null,
            progress: 0,
            state: "queued",
            updatedAt: now,
          })
          .where(eq(jobs.id, job.id))
          .run();
        return { id: job.id, outcome: "requeued" as const };
      });

      return {
        canceled: outcomes.filter(({ outcome }) => outcome === "canceled").map(({ id }) => id),
        failed: outcomes.filter(({ outcome }) => outcome === "failed").map(({ id }) => id),
        requeued: outcomes.filter(({ outcome }) => outcome === "requeued").map(({ id }) => id),
      };
    },
    { behavior: "immediate" },
  );

export const findJobsByIds = ({ db }: Database, ids: ReadonlyArray<string>) =>
  ids.length === 0
    ? []
    : db.select().from(jobs).where(inArray(jobs.id, ids)).orderBy(asc(jobs.createdAt)).all();

export const failJob = (
  database: Database,
  { errorCode, errorJson, jobId, now, workerId }: FailJobOptions,
) =>
  database.db.transaction(
    (transaction) => {
      const failed = transaction
        .update(jobs)
        .set({
          completedAt: now,
          errorCode,
          errorJson,
          leaseExpiresAt: null,
          leaseOwner: null,
          state: "failed",
          updatedAt: now,
        })
        .where(
          and(
            eq(jobs.id, jobId),
            inArray(jobs.state, ["analyzing", "processing"]),
            eq(jobs.leaseOwner, workerId),
          ),
        )
        .returning()
        .get();

      if (failed === undefined) return undefined;

      transaction
        .update(jobAttempts)
        .set({ completedAt: now, errorCode, outcome: "failed" })
        .where(
          and(
            eq(jobAttempts.jobId, failed.id),
            eq(jobAttempts.attempt, failed.attemptCount),
            eq(jobAttempts.outcome, "running"),
          ),
        )
        .run();

      return failed;
    },
    { behavior: "immediate" },
  );
