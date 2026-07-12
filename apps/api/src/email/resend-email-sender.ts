import { Effect } from "effect";
import { Resend } from "resend";

import { EmailSendError, type EmailSender } from "./email-outbox-worker.ts";

interface ResendPayload {
  readonly from: string;
  readonly html: string;
  readonly subject: string;
  readonly text: string;
  readonly to: string;
}

type ResendResponse =
  | { readonly data: { readonly id: string }; readonly error: null }
  | {
      readonly data: null;
      readonly error: { readonly name: string; readonly statusCode: number | null };
    };

export interface ResendEmailClient {
  readonly send: (
    payload: ResendPayload,
    options: { readonly idempotencyKey: string },
  ) => Promise<ResendResponse>;
}

export const makeResendEmailSender = (client: ResendEmailClient): EmailSender => ({
  send: Effect.fn("ResendEmailSender.send")(function* (input) {
    const response = yield* Effect.tryPromise({
      catch: () => new EmailSendError({ providerCode: "network-error", retryable: true }),
      try: () =>
        client.send(
          {
            from: input.from,
            html: input.html,
            subject: input.subject,
            text: input.text,
            to: input.to,
          },
          { idempotencyKey: input.idempotencyKey },
        ),
    });
    if (response.error === null) return;

    const statusCode = response.error.statusCode;
    return yield* new EmailSendError({
      providerCode: response.error.name,
      retryable: statusCode === 429 || (statusCode !== null && statusCode >= 500),
    });
  }),
});

export const makeConfiguredResendEmailSender = (apiKey: string) => {
  const resend = new Resend(apiKey);
  return makeResendEmailSender({
    send: async (payload, options) => {
      const response = await resend.emails.send(payload, options);
      if (response.error !== null) {
        return {
          data: null,
          error: {
            name: response.error.name,
            statusCode: response.error.statusCode,
          },
        };
      }
      return { data: response.data, error: null };
    },
  });
};
