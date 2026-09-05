import { Effect, Schema } from "effect";

import type { Database } from "../database/database.ts";
import type { MagicLinkOpener } from "../auth/magic-link-secret.ts";
import { claimNextEmail, markEmailFailed, markEmailSent } from "./email-outbox-repository.ts";
import { emailDeliveryContent } from "./email-delivery-content.ts";

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
    Effect.try({
      try: () => emailDeliveryContent(input.database, email, input.now, input.openMagicLink),
      catch: () => new EmailSendError({ providerCode: "invalid-outbox-secret", retryable: false }),
    }).pipe(
      Effect.flatMap((content) => {
        if (content === undefined)
          return Effect.fail(
            new EmailSendError({ providerCode: "notification-no-longer-valid", retryable: false }),
          );
        return input.sender.send({
          ...content,
          from: input.config.from,
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

const tryStorage = Effect.fn("EmailOutboxWorker.tryStorage")(
  <Value>(operation: string, evaluate: () => Value) =>
    Effect.try({
      catch: (cause) => new EmailOutboxStorageError({ cause, operation }),
      try: evaluate,
    }),
);
