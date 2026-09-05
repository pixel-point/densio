import { PLAN_CATALOG, JobProgressSchema } from "@densio/shared";
import { and, asc, desc, eq, gt, inArray, lte } from "drizzle-orm";
import { Schema } from "effect";
import { creditsFromUnits } from "../billing/credit-units.ts";
import type { Database } from "./database.ts";
import { holdJobCredits } from "./job-credit-ledger.ts";
import { appendJobEvent } from "./job-event-repository.ts";
import { applyJobTransition } from "./job-transition-repository.ts";
import { jobs, executionPlans } from "./schema.ts";
import { authorizeOrganization } from "../organizations/organization-access.ts";
import { organizationFailure } from "../organizations/organization-errors.ts";
import { resolveJobAdmission, type JobAdmissionPolicy } from "./job-admission.ts";

export const createJob = (
  database: Database,
  values: typeof jobs.$inferInsert,
  creditPolicy: JobAdmissionPolicy,
  pendingSnapshot?: typeof executionPlans.$inferInsert,
) =>
  database.db.transaction(
    (transaction) => {
      authorizeOrganization(transaction, creditPolicy.actor, "media-write");
      if (
        values.organizationId !== creditPolicy.actor.organizationId ||
        values.createdByUserId !== creditPolicy.actor.userId
      )
        throw organizationFailure("ORGANIZATION_ACCESS_DENIED", "Job actor mismatch.");
      const existing =
        values.idempotencyKey === null || values.idempotencyKey === undefined
          ? undefined
          : transaction
              .select()
              .from(jobs)
              .where(
                and(
                  eq(jobs.organizationId, values.organizationId),
                  eq(jobs.idempotencyKey, values.idempotencyKey),
                ),
              )
              .get();

      if (existing !== undefined)
        return existing.requestDigest === values.requestDigest
          ? { created: false as const, job: existing }
          : { kind: "idempotency-conflict" as const };

      const clientReferenceConflict =
        values.clientReference === null || values.clientReference === undefined
          ? undefined
          : transaction
              .select({ id: jobs.id })
              .from(jobs)
              .where(
                and(
                  eq(jobs.organizationId, values.organizationId),
                  eq(jobs.clientReference, values.clientReference),
                ),
              )
              .get();
      if (clientReferenceConflict !== undefined) {
        return { kind: "client-reference-conflict" as const };
      }

      const { entitlement, periodStart, availableUnits } = resolveJobAdmission(
        database,
        transaction,
        values,
        creditPolicy,
        pendingSnapshot,
      );
      const initialCreditUnits = values.quoteCreditUnits;
      if (
        !Number.isSafeInteger(initialCreditUnits) ||
        initialCreditUnits <= 0 ||
        values.state !== "preparing"
      ) {
        throw new Error("Job creation requires a preparing state and a positive exact quote");
      }
      if (availableUnits < initialCreditUnits) {
        return {
          availableCredits: creditsFromUnits(availableUnits),
          kind: "insufficient-credits" as const,
        };
      }

      if (pendingSnapshot) transaction.insert(executionPlans).values(pendingSnapshot).run();
      const job = transaction
        .insert(jobs)
        .values({
          ...values,
          subscriptionPlan: entitlement.entitlements.plan,
          queuePriority: PLAN_CATALOG[entitlement.entitlements.plan].queuePriority,
          createdAt: creditPolicy.now,
          updatedAt: creditPolicy.now,
        })
        .returning()
        .get();
      holdJobCredits(transaction, job, periodStart, initialCreditUnits);
      appendJobEvent(transaction, {
        attempt: job.attemptCount,
        jobId: job.id,
        kind: "created",
        occurredAt: job.createdAt,
        progress: Schema.decodeUnknownSync(Schema.fromJsonString(JobProgressSchema))(
          job.progressJson,
        ),
        state: job.state,
      });
      return { created: true as const, job };
    },
    { behavior: "immediate" },
  );

export const claimNextJob = (
  database: Database,
  input: { readonly leaseDurationMs: number; readonly now: number; readonly workerId: string },
) =>
  database.db.transaction(
    (transaction) => {
      const candidate = transaction
        .select()
        .from(jobs)
        .where(eq(jobs.state, "queued"))
        .orderBy(desc(jobs.queuePriority), asc(jobs.createdAt), asc(jobs.id))
        .limit(1)
        .get();
      return candidate === undefined
        ? undefined
        : applyJobTransition(transaction, {
            jobId: candidate.id,
            now: input.now,
            command: {
              type: "claim",
              workerId: input.workerId,
              leaseDurationMs: input.leaseDurationMs,
            },
          });
    },
    { behavior: "immediate" },
  );

export const recoverExpiredJobs = (
  database: Database,
  input: { readonly maxAttempts: number; readonly now: number },
) =>
  database.db.transaction(
    (transaction) => {
      const expired = transaction
        .select()
        .from(jobs)
        .where(
          and(
            inArray(jobs.state, ["analyzing", "processing", "publishing"]),
            lte(jobs.leaseExpiresAt, input.now),
          ),
        )
        .orderBy(asc(jobs.createdAt), asc(jobs.id))
        .all();
      const outcomes = expired.flatMap((job) => {
        const updated = applyJobTransition(transaction, {
          jobId: job.id,
          now: input.now,
          command: { type: "recover", maxAttempts: input.maxAttempts },
        });
        return updated === undefined ? [] : [updated];
      });
      return {
        canceled: outcomes.filter(({ state }) => state === "canceled").map(({ id }) => id),
        failed: outcomes.filter(({ state }) => state === "failed").map(({ id }) => id),
        requeued: outcomes.filter(({ state }) => state === "queued").map(({ id }) => id),
      };
    },
    { behavior: "immediate" },
  );

export const findJobsByIds = ({ db }: Database, ids: ReadonlyArray<string>) =>
  ids.length === 0
    ? []
    : db.select().from(jobs).where(inArray(jobs.id, ids)).orderBy(asc(jobs.createdAt)).all();

export const findOwnedJob = (
  { db }: Database,
  input: { readonly jobId: string; readonly organizationId: string },
) =>
  db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, input.jobId), eq(jobs.organizationId, input.organizationId)))
    .get();

export const findJobByIdempotencyKey = ({ db }: Database, organizationId: string, key: string) =>
  db
    .select()
    .from(jobs)
    .where(and(eq(jobs.organizationId, organizationId), eq(jobs.idempotencyKey, key)))
    .get();

export const listPreparingJobs = ({ db }: Database, limit: number, afterId?: string) =>
  db
    .select()
    .from(jobs)
    .where(
      and(eq(jobs.state, "preparing"), afterId === undefined ? undefined : gt(jobs.id, afterId)),
    )
    .orderBy(asc(jobs.id))
    .limit(limit)
    .all();

export const isJobCancellationRequested = (
  { db }: Database,
  jobId: string,
  workerId: string,
  attempt: number,
) => {
  const job = db
    .select({ requested: jobs.cancelRequestedAt })
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.leaseOwner, workerId), eq(jobs.attemptCount, attempt)))
    .get();
  return job?.requested !== null && job?.requested !== undefined;
};
