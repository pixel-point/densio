import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";

import type { Database } from "../database/database.ts";
import { authChallenges, emailOutbox } from "../database/schema.ts";

export type OutboxEmail = typeof emailOutbox.$inferSelect;

export interface ClaimedOutboxEmail extends OutboxEmail {
  readonly challengeExpiresAt: number;
}

export const claimNextEmail = (
  { db }: Database,
  input: { readonly leaseMs: number; readonly now: number },
): ClaimedOutboxEmail | undefined =>
  db.transaction(
    (transaction) => {
      const due = transaction
        .select({ challengeExpiresAt: authChallenges.expiresAt, email: emailOutbox })
        .from(emailOutbox)
        .innerJoin(authChallenges, eq(emailOutbox.challengeId, authChallenges.id))
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
        .where(eq(emailOutbox.id, due.email.id))
        .run();
      return {
        ...due.email,
        attempts: due.email.attempts + 1,
        challengeExpiresAt: due.challengeExpiresAt,
        nextAttemptAt: input.now + input.leaseMs,
        status: "sending" as const,
      };
    },
    { behavior: "immediate" },
  );

export const markEmailSent = ({ db }: Database, id: string, now: number) => {
  db.update(emailOutbox)
    .set({ encryptedConfirmationUrl: null, lastError: null, sentAt: now, status: "sent" })
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
      ...(canRetry ? {} : { encryptedConfirmationUrl: null }),
      lastError: input.providerCode.slice(0, 200),
      nextAttemptAt: retryAt,
      status: "failed",
    })
    .where(eq(emailOutbox.id, input.id))
    .run();
  return canRetry ? retryAt : undefined;
};
