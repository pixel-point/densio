import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import type { DatabaseTransaction } from "./database.ts";
import { jobCreditEntries, jobs } from "./schema.ts";

type Job = typeof jobs.$inferSelect;

export const reservedCreditUnits = sql<number>`coalesce(sum(case
  when ${jobCreditEntries.kind} = 'hold' then ${jobCreditEntries.units}
  when ${jobCreditEntries.kind} = 'release' then -${jobCreditEntries.units}
  else 0
end), 0)`;

export const usedCreditUnits = sql<number>`coalesce(sum(case
  when ${jobCreditEntries.kind} = 'usage' then ${jobCreditEntries.units}
  else 0
end), 0)`;

export const creditPeriodTotals = (
  transaction: DatabaseTransaction,
  organizationId: string,
  periodStart: number,
) =>
  transaction
    .select({ reservedUnits: reservedCreditUnits, usedUnits: usedCreditUnits })
    .from(jobCreditEntries)
    .where(
      sql`${jobCreditEntries.organizationId} = ${organizationId} and ${jobCreditEntries.periodStart} = ${periodStart}`,
    )
    .get() ?? { reservedUnits: 0, usedUnits: 0 };

export const holdJobCredits = (
  transaction: DatabaseTransaction,
  job: Job,
  periodStart: number,
  units: number,
) => insertEntry(transaction, job, periodStart, "hold", units, job.createdAt);

export const jobReservedCreditUnits = (transaction: DatabaseTransaction, jobId: string) =>
  transaction
    .select({ units: reservedCreditUnits })
    .from(jobCreditEntries)
    .where(eq(jobCreditEntries.jobId, jobId))
    .get()?.units ?? 0;

export const releaseJobCredits = (transaction: DatabaseTransaction, job: Job, now: number) => {
  const reservation = jobReservation(transaction, job.id);
  if (reservation === undefined || reservation.units <= 0) return undefined;
  insertEntry(transaction, job, reservation.periodStart, "release", reservation.units, now);
  return reservation;
};

export const settleJobCredits = (transaction: DatabaseTransaction, job: Job, now: number) => {
  const reservation = releaseJobCredits(transaction, job, now);
  if (reservation === undefined) return;
  insertEntry(transaction, job, reservation.periodStart, "usage", reservation.units, now);
};

const jobReservation = (transaction: DatabaseTransaction, jobId: string) =>
  transaction
    .select({ periodStart: jobCreditEntries.periodStart, units: reservedCreditUnits })
    .from(jobCreditEntries)
    .where(eq(jobCreditEntries.jobId, jobId))
    .groupBy(jobCreditEntries.periodStart)
    .get();

const insertEntry = (
  transaction: DatabaseTransaction,
  job: Job,
  periodStart: number,
  kind: typeof jobCreditEntries.$inferInsert.kind,
  units: number,
  createdAt: number,
) =>
  transaction
    .insert(jobCreditEntries)
    .values({
      createdAt,
      id: randomUUID(),
      jobId: job.id,
      kind,
      periodStart,
      units,
      organizationId: job.organizationId,
    })
    .run();
