import { randomUUID } from "node:crypto";
import { recordAutomaticVideo } from "../videos/automatic-video.ts";
import { JobProgressSchema, type JobProgress } from "@densio/shared";
import { and, asc, desc, eq } from "drizzle-orm";
import { Schema } from "effect";
import {
  reduceJobTransition,
  type JobTransition,
  type JobTransitionCommand,
} from "../jobs/job-transition.ts";
import type { Database, DatabaseTransaction } from "./database.ts";
import {
  authorizeOrganization,
  type OrganizationActor,
} from "../organizations/organization-access.ts";
import {
  jobReservedCreditUnits,
  releaseJobCredits,
  settleJobCredits,
} from "./job-credit-ledger.ts";
import { appendJobEvent } from "./job-event-repository.ts";
import { buildJobExecutionReceipt } from "./job-receipt.ts";
import {
  artifacts,
  jobAttempts,
  jobCreditEntries,
  jobEvents,
  jobs,
  mediaCommands,
} from "./schema.ts";

interface TransitionInput {
  readonly jobId: string;
  readonly now: number;
  readonly expectedRevision?: number;
  readonly command: JobTransitionCommand;
}

export const transitionJob = (database: Database, input: TransitionInput) =>
  database.db.transaction((transaction) => applyJobTransition(transaction, input), {
    behavior: "immediate",
  });

// Member authority and worker authority are deliberately separate entry points.
// The member cannot supply an organization independently of their authorization.
export const cancelOrganizationJob = (
  database: Database,
  input: {
    actor: OrganizationActor;
    jobId: string;
    now: number;
  },
) =>
  database.db.transaction(
    (transaction) => {
      authorizeOrganization(transaction, input.actor, "media-write");
      const owned = transaction
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.id, input.jobId), eq(jobs.organizationId, input.actor.organizationId)))
        .get();
      if (owned === undefined) return undefined;
      return applyJobTransition(transaction, {
        jobId: owned.id,
        now: input.now,
        command: { type: "cancel" },
      });
    },
    { behavior: "immediate" },
  );

// This is the sole job-row writer after creation. Publication uses it inside its own transaction.
export const applyJobTransition = (transaction: DatabaseTransaction, input: TransitionInput) => {
  const current = transaction.select().from(jobs).where(eq(jobs.id, input.jobId)).get();
  if (
    current === undefined ||
    (input.expectedRevision !== undefined && current.revision !== input.expectedRevision)
  )
    return undefined;
  const progress = Schema.decodeUnknownSync(Schema.fromJsonString(JobProgressSchema))(
    current.progressJson,
  );
  const transition = reduceJobTransition(
    { ...current, progress, reservedCreditUnits: jobReservedCreditUnits(transaction, current.id) },
    input.command,
    input.now,
  );
  if (transition === undefined || throttled(transaction, current, transition, input.now))
    return undefined;
  const next = transitionRow(current, transition, input.now);
  if (transition.credit === "release") releaseJobCredits(transaction, next, input.now);
  if (transition.credit === "settle") settleJobCredits(transaction, next, input.now);
  recordAttempt(transaction, current, transition, input.now);
  const receiptJson =
    transition.completedAt === undefined
      ? current.receiptJson
      : JSON.stringify(buildJobExecutionReceipt(next, receiptEvidence(transaction, current.id)));
  const updated = transaction
    .update(jobs)
    .set({ ...next, receiptJson })
    .where(and(eq(jobs.id, current.id), eq(jobs.revision, current.revision)))
    .returning()
    .get();
  if (updated === undefined) throw new Error("Job revision changed inside a write transaction");
  if (transition.completedAt !== undefined && updated.state === "succeeded")
    recordAutomaticVideo(transaction, updated, input.now);
  if (transition.event !== undefined)
    appendJobEvent(transaction, {
      jobId: current.id,
      attempt: updated.attemptCount,
      occurredAt: input.now,
      kind: transition.event,
      state: updated.state,
      progress: transition.next.progress,
    });
  return updated;
};

const transitionRow = (
  current: typeof jobs.$inferSelect,
  transition: JobTransition,
  now: number,
): typeof jobs.$inferSelect => {
  const { progress, quoteCreditUnits: _, reservedCreditUnits: __, ...lifecycle } = transition.next;
  return {
    ...current,
    ...lifecycle,
    updatedAt: now,
    progressJson: JSON.stringify(progress),
    ...(transition.completedAt === undefined ? {} : { completedAt: transition.completedAt }),
    ...(transition.resultJson === undefined ? {} : { resultJson: transition.resultJson }),
    ...(transition.toolchainJson === undefined ? {} : { toolchainJson: transition.toolchainJson }),
    ...(transition.failure === undefined
      ? {}
      : {
          errorCode: transition.failure.code,
          errorJson: JSON.stringify({
            message: transition.failure.message,
            details: transition.failure.details,
          }),
        }),
  };
};

const recordAttempt = (
  transaction: DatabaseTransaction,
  current: typeof jobs.$inferSelect,
  transition: JobTransition,
  now: number,
) => {
  if (transition.attemptOutcome === undefined) return;
  if (transition.attemptOutcome === "running") {
    if (transition.next.leaseOwner === null) throw new Error("A claim requires a lease owner");
    transaction
      .insert(jobAttempts)
      .values({
        id: randomUUID(),
        jobId: current.id,
        attempt: transition.next.attemptCount,
        workerId: transition.next.leaseOwner,
        startedAt: now,
        outcome: "running",
      })
      .run();
    return;
  }
  transaction
    .update(jobAttempts)
    .set({
      completedAt: now,
      outcome: transition.attemptOutcome,
      errorCode: transition.failure?.code ?? null,
    })
    .where(
      and(
        eq(jobAttempts.jobId, current.id),
        eq(jobAttempts.attempt, current.attemptCount),
        eq(jobAttempts.outcome, "running"),
      ),
    )
    .run();
};

const receiptEvidence = (transaction: DatabaseTransaction, jobId: string) => ({
  artifacts: transaction
    .select()
    .from(artifacts)
    .where(eq(artifacts.jobId, jobId))
    .orderBy(asc(artifacts.createdAt), asc(artifacts.id))
    .all(),
  commands: transaction
    .select()
    .from(mediaCommands)
    .where(eq(mediaCommands.jobId, jobId))
    .orderBy(asc(mediaCommands.startedAt), asc(mediaCommands.id))
    .all(),
  actualCreditUnits: transaction
    .select({ units: jobCreditEntries.units })
    .from(jobCreditEntries)
    .where(and(eq(jobCreditEntries.jobId, jobId), eq(jobCreditEntries.kind, "usage")))
    .all()
    .reduce((sum, { units }) => sum + units, 0),
});

const throttled = (
  transaction: DatabaseTransaction,
  current: typeof jobs.$inferSelect,
  transition: JobTransition,
  now: number,
) => {
  if (transition.event !== "progress") return false;
  const previous = Schema.decodeUnknownSync(Schema.fromJsonString(JobProgressSchema))(
    current.progressJson,
  );
  if (
    previous.phase !== transition.next.progress.phase ||
    transition.next.progress.percent - previous.percent >= 1
  )
    return false;
  if (
    outputProgressSignature(previous.activeOutputs) !==
    outputProgressSignature(transition.next.progress.activeOutputs)
  )
    return false;
  const last = transaction
    .select({ occurredAt: jobEvents.occurredAt })
    .from(jobEvents)
    .where(and(eq(jobEvents.jobId, current.id), eq(jobEvents.kind, "progress")))
    .orderBy(desc(jobEvents.sequence))
    .limit(1)
    .get();
  return last !== undefined && now - last.occurredAt < 1_000;
};

const outputProgressSignature = (outputs: JobProgress["activeOutputs"]) =>
  JSON.stringify(
    outputs?.map(({ index, total, codec, filename, variantId, totalDurationSeconds }) => [
      index,
      total,
      codec,
      filename,
      variantId,
      totalDurationSeconds,
    ]),
  );
