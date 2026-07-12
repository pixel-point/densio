import { Effect } from "effect";
import { expect, it } from "vitest";

import { makeResendEmailSender, type ResendEmailClient } from "../src/email/resend-email-sender.ts";

const message = {
  from: "Media API <login@example.com>",
  html: "<p>Confirm</p>",
  idempotencyKey: "auth-email-email-1",
  subject: "Confirm login",
  text: "Confirm",
  to: "agent@example.com",
};

it("passes an idempotency key to Resend", async () => {
  const requests: Array<unknown> = [];
  const client: ResendEmailClient = {
    send: (payload, options) => {
      requests.push({ options, payload });
      return Promise.resolve({ data: { id: "email-1" }, error: null });
    },
  };

  await Effect.runPromise(makeResendEmailSender(client).send(message));

  expect(requests).toEqual([
    {
      options: { idempotencyKey: "auth-email-email-1" },
      payload: expect.objectContaining({ to: "agent@example.com" }),
    },
  ]);
});

it("classifies retryable provider and network failures", async () => {
  const providerClient: ResendEmailClient = {
    send: () =>
      Promise.resolve({
        data: null,
        error: { name: "rate_limit_exceeded", statusCode: 429 },
      }),
  };
  const networkClient: ResendEmailClient = {
    send: () => Promise.reject(new Error("token=must-not-leak")),
  };

  await expect(
    Effect.runPromise(Effect.flip(makeResendEmailSender(providerClient).send(message))),
  ).resolves.toMatchObject({ providerCode: "rate_limit_exceeded", retryable: true });
  await expect(
    Effect.runPromise(Effect.flip(makeResendEmailSender(networkClient).send(message))),
  ).resolves.toMatchObject({ providerCode: "network-error", retryable: true });
});
