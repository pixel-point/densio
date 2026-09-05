import {
  renderOrganizationInvitationEmail,
  renderSignInConfirmationEmail,
  renderStorageRetentionEmail,
} from "@densio/emails";
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { makeConfiguredResendEmailSender } from "../src/email/resend-email-sender.ts";
import { bindApplicationServer, startApplicationServer } from "../src/http/application-server.ts";

afterEach(() => vi.unstubAllEnvs());

const messages = [
  {
    kind: "sign-in",
    render: () =>
      renderSignInConfirmationEmail({
        verificationUrl: "https://api.example.test/v1/auth/confirm?token=fixture",
      }),
  },
  {
    kind: "invitation",
    render: () =>
      renderOrganizationInvitationEmail({
        name: "Example Studio",
        acceptanceUrl: "https://api.example.test/v1/organization-invitations/confirm?token=fixture",
      }),
  },
  {
    kind: "storage",
    render: () =>
      renderStorageRetentionEmail({
        organizationName: "Example Studio",
        deadline: Date.UTC(2027, 0, 15),
      }),
  },
];

it.each(messages)("sends the $kind template through the configured Resend SDK", async (message) => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const requests: {
          method: string;
          path: string;
          authorization: string | null;
          idempotencyKey: string | null;
          payload: unknown;
        }[] = [];
        const binding = yield* bindApplicationServer("127.0.0.1", 0);
        yield* startApplicationServer(
          "127.0.0.1",
          binding.port,
          async (request) => {
            requests.push({
              method: request.method,
              path: new URL(request.url).pathname,
              authorization: request.headers.get("authorization"),
              idempotencyKey: request.headers.get("idempotency-key"),
              payload: await request.json(),
            });
            return Response.json({ id: "email-local-fixture" });
          },
          binding,
        );
        vi.stubEnv("RESEND_BASE_URL", `http://127.0.0.1:${binding.port}`);
        const content = yield* Effect.promise(message.render);
        const payload = {
          ...content,
          from: "Densio <notify@example.test>",
          to: "recipient@example.test",
        };
        yield* makeConfiguredResendEmailSender("re_local_fixture").send({
          ...payload,
          idempotencyKey: `email-${message.kind}`,
        });
        expect(requests).toEqual([
          {
            method: "POST",
            path: "/emails",
            authorization: "Bearer re_local_fixture",
            idempotencyKey: `email-${message.kind}`,
            payload,
          },
        ]);
        expect(content.html).toContain("<h1");
        expect(content.html).toContain("Prime UI, Inc.");
        expect(content.text).toContain("Prime UI, Inc.");
      }),
    ),
  );
});
