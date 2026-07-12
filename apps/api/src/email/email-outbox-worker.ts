import { Effect, Schema } from "effect";

import type { Database } from "../database/database.ts";
import { renderMagicLinkEmail } from "../auth/magic-link-email.ts";
import type { MagicLinkOpener } from "../auth/magic-link-secret.ts";
import { claimNextEmail, markEmailFailed, markEmailSent } from "./email-outbox-repository.ts";

export class EmailSendError extends Schema.TaggedErrorClass<EmailSendError>()("EmailSendError", {
  providerCode: Schema.String,
  retryable: Schema.Boolean,
}) {}

export class EmailOutboxStorageError extends Schema.TaggedErrorClass<EmailOutboxStorageError>()(
  "EmailOutboxStorageError",
  { cause: Schema.Defect(), operation: Schema.String },
) {}

export interface EmailSender {
  readonly send: (input: {
    readonly from: string;
    readonly html: string;
    readonly idempotencyKey: string;
    readonly subject: string;
    readonly text: string;
    readonly to: string;
  }) => Effect.Effect<void, EmailSendError>;
}

export interface EmailOutboxWorkerConfig {
  readonly from: string;
  readonly leaseMs: number;
  readonly maxAttempts: number;
  readonly retryBaseMs: number;
}

export const deliverNextEmail = Effect.fn("EmailOutboxWorker.deliverNextEmail")(function* (input: {
  readonly config: EmailOutboxWorkerConfig;
  readonly database: Database;
  readonly now: number;
  readonly openMagicLink: MagicLinkOpener;
  readonly sender: EmailSender;
}) {
  const email = yield* tryStorage("claim", () =>
    claimNextEmail(input.database, { leaseMs: input.config.leaseMs, now: input.now }),
  );
  if (email === undefined) return { kind: "idle" as const };

  const delivery = yield* Effect.match(
    decryptMagicLink(email.encryptedConfirmationUrl, input.openMagicLink, {
      challengeId: email.challengeId,
      emailId: email.id,
      recipient: email.recipient,
    }).pipe(
      Effect.flatMap((verificationUrl) => {
        const content = renderMagicLinkEmail({
          expiresInMinutes: Math.max(1, Math.ceil((email.challengeExpiresAt - input.now) / 60_000)),
          verificationUrl,
        });
        return input.sender.send({
          ...content,
          from: input.config.from,
          idempotencyKey: `auth-email-${email.id}`,
          to: email.recipient,
        });
      }),
    ),
    {
      onFailure: (error) => ({ error, kind: "failed" as const }),
      onSuccess: () => ({ kind: "sent" as const }),
    },
  );

  if (delivery.kind === "sent") {
    yield* tryStorage("mark-sent", () => markEmailSent(input.database, email.id, input.now));
    return { kind: "sent" as const };
  }

  const retryAt = yield* tryStorage("mark-failed", () =>
    markEmailFailed(input.database, {
      attempts: email.attempts,
      id: email.id,
      maxAttempts: input.config.maxAttempts,
      now: input.now,
      providerCode: delivery.error.providerCode,
      retryBaseMs: input.config.retryBaseMs,
      retryable: delivery.error.retryable,
    }),
  );
  if (retryAt !== undefined) return { kind: "retry-scheduled" as const, retryAt };
  return { kind: "failed" as const };
});

const decryptMagicLink = (
  sealed: string | null,
  openMagicLink: MagicLinkOpener,
  context: Parameters<MagicLinkOpener>[1],
) =>
  Effect.try({
    catch: () => new EmailSendError({ providerCode: "invalid-outbox-secret", retryable: false }),
    try: () => {
      if (sealed === null) throw new Error("Missing encrypted payload");
      return openMagicLink(sealed, context);
    },
  });

const tryStorage = Effect.fn("EmailOutboxWorker.tryStorage")(
  <Value>(operation: string, evaluate: () => Value) =>
    Effect.try({
      catch: (cause) => new EmailOutboxStorageError({ cause, operation }),
      try: evaluate,
    }),
);
