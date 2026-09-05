import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";

import type { Database } from "../database/database.ts";
import { emailOutbox } from "../database/schema.ts";

export type OutboxEmail = typeof emailOutbox.$inferSelect;

export const claimNextEmail = (
  { db }: Database,
  input: { readonly leaseMs: number; readonly now: number },
): OutboxEmail | undefined =>
  db.transaction(
    (transaction) => {
      const due = transaction
        .select()
        .from(emailOutbox)
        .where(
          or(
            and(
              inArray(emailOutbox.status, ["pending", "failed"]),
              lte(emailOutbox.nextAttemptAt, input.now),
            ),
            and(eq(emailOutbox.status, "sending"), lte(emailOutbox.nextAttemptAt, input.now)),
          ),
        )
        .orderBy(asc(emailOutbox.createdAt))
        .get();
      if (due === undefined) return undefined;

      transaction
        .update(emailOutbox)
        .set({
          attempts: sql`${emailOutbox.attempts} + 1`,
          nextAttemptAt: input.now + input.leaseMs,
          status: "sending",
        })
        .where(eq(emailOutbox.id, due.id))
        .run();
      return {
        ...due,
        attempts: due.attempts + 1,
        nextAttemptAt: input.now + input.leaseMs,
        status: "sending" as const,
      };
    },
    { behavior: "immediate" },
  );

export const markEmailSent = ({ db }: Database, id: string, now: number) => {
  db.update(emailOutbox)
    .set({ payloadJson: null, lastError: null, sentAt: now, status: "sent" })
    .where(eq(emailOutbox.id, id))
    .run();
};

export const markEmailFailed = (
  { db }: Database,
  input: {
    readonly attempts: number;
    readonly id: string;
    readonly maxAttempts: number;
    readonly now: number;
    readonly providerCode: string;
    readonly retryBaseMs: number;
    readonly retryable: boolean;
  },
) => {
  const canRetry = input.retryable && input.attempts < input.maxAttempts;
  const retryAt = canRetry
    ? input.now + input.retryBaseMs * 2 ** (input.attempts - 1)
    : Number.MAX_SAFE_INTEGER;
  db.update(emailOutbox)
    .set({
      ...(canRetry ? {} : { payloadJson: null }),
      lastError: input.providerCode.slice(0, 200),
      nextAttemptAt: retryAt,
      status: "failed",
    })
    .where(eq(emailOutbox.id, input.id))
    .run();
  return canRetry ? retryAt : undefined;
};
