import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";

import type { Database } from "./database.ts";
import { jobCreditEntries, jobs } from "./schema.ts";

export type DatabaseTransaction = Parameters<Parameters<Database["db"]["transaction"]>[0]>[0];
type Job = typeof jobs.$inferSelect;

export const reservedCreditUnits = sql<number>`coalesce(sum(case
  when ${jobCreditEntries.kind} in ('hold', 'adjustment') then ${jobCreditEntries.units}
  when ${jobCreditEntries.kind} = 'release' then -${jobCreditEntries.units}
  else 0
end), 0)`;

export const usedCreditUnits = sql<number>`coalesce(sum(case
  when ${jobCreditEntries.kind} = 'usage' then ${jobCreditEntries.units}
  else 0
end), 0)`;

export const creditPeriodTotals = (
  transaction: DatabaseTransaction,
  userId: string,
  periodStart: number,
) =>
  transaction
    .select({ reservedUnits: reservedCreditUnits, usedUnits: usedCreditUnits })
    .from(jobCreditEntries)
    .where(
      sql`${jobCreditEntries.userId} = ${userId} and ${jobCreditEntries.periodStart} = ${periodStart}`,
    )
    .get() ?? { reservedUnits: 0, usedUnits: 0 };

export const holdJobCredits = (
  transaction: DatabaseTransaction,
  job: Job,
  periodStart: number,
  units: number,
) => insertEntry(transaction, job, periodStart, "hold", units, job.createdAt);

export const reserveExactJobCredits = (
  transaction: DatabaseTransaction,
  job: Job,
  requiredUnits: number,
  monthlyUnits: number,
  now: number,
) => {
  const reservation = jobReservation(transaction, job.id);
  if (reservation === undefined || reservation.units <= 0) {
    return { kind: "missing-reservation" as const };
  }
  const totals = creditPeriodTotals(transaction, job.userId, reservation.periodStart);
  const additionalUnits = Math.max(0, requiredUnits - reservation.units);
  const availableUnits = Math.max(0, monthlyUnits - totals.reservedUnits - totals.usedUnits);
  if (additionalUnits > availableUnits) {
    return { availableUnits, kind: "insufficient-credits" as const };
  }

  if (additionalUnits > 0) {
    insertEntry(transaction, job, reservation.periodStart, "adjustment", additionalUnits, now);
  }
  return { kind: "reserved" as const };
};

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
      userId: job.userId,
    })
    .run();
