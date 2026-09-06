import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { startApplication } from "../../apps/api/src/application.ts";
import { loadConfig } from "../../apps/api/src/config.ts";
import type { EmailSender } from "../../apps/api/src/email/email-outbox-worker.ts";
import type { StripeGatewayDefinition } from "../../apps/api/src/billing/stripe-gateway.ts";

// A disposable, loopback-only API with a separate test inbox. No production test routes.
const directory = await mkdtemp(join(tmpdir(), "densio-website-preview-"));
const messages: { to: string; html: string }[] = [];
const sender: EmailSender = {
  send: (message) =>
    Effect.sync(() => {
      messages.unshift({ to: message.to, html: message.html });
    }),
};
const inbox = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
  response.end(
    `<!doctype html><html><body><h1>Local test inbox</h1>${messages.map((message, index) => `<section><h2>Message ${index + 1}</h2>${message.html}</section>`).join("")}</body></html>`,
  );
});
inbox.listen(3802, "127.0.0.1");
const unexpected = () => Effect.die("Unexpected provider operation in local website preview");
const gateway: StripeGatewayDefinition = {
  retrieveCustomer: () => Effect.succeed(null),
  createCustomer: () => Effect.succeed("cus_preview"),
  findCustomer: () => Effect.succeed(null),
  updateCustomer: () => Effect.void,
  findCheckoutSession: () => Effect.succeed(null),
  retrieveCheckoutSession: unexpected,
  listCustomerSubscriptions: () => Effect.succeed([]),
  createCheckoutSession: (request) =>
    Effect.succeed({
      id: "cs_preview",
      url: request.success_url ?? "http://127.0.0.1:3801/checkout/success",
      status: "open",
      customerId: "cus_preview",
      subscriptionId: null,
      expiresAt: Date.now() + 1_800_000,
      organizationId: request.client_reference_id ?? "",
      attemptId: String(request.metadata?.attemptId),
    }),
  createPortalSession: (request) =>
    Effect.succeed({
      id: "bps_preview",
      url: request.return_url ?? "http://127.0.0.1:3801/billing",
    }),
  parseWebhook: unexpected,
  retrieveSubscription: unexpected,
};
const config = loadConfig({
  HOST: "127.0.0.1",
  PORT: "3800",
  PUBLIC_BASE_URL: "http://127.0.0.1:3800",
  WEBSITE_BASE_URL: "http://127.0.0.1:3801",
  DATABASE_PATH: join(directory, "database.sqlite"),
  MEDIA_ROOT: join(directory, "media"),
  AUTH_IP_HASH_SECRET: "website-preview-secret-long-enough-for-local-only",
  AUTH_OUTBOX_ENCRYPTION_KEY: "0123456789abcdef".repeat(4),
  EMAIL_FROM: "Densio <login@densio.test>",
  EMAIL_POLL_INTERVAL_MS: "100",
  RESEND_API_KEY: "re_preview",
  STRIPE_BASIC_PRICE_ID: "price_basic_preview",
  STRIPE_PRO_PRICE_ID: "price_pro_preview",
  STRIPE_SCALE_PRICE_ID: "price_scale_preview",
  STRIPE_SECRET_KEY: "sk_test_preview",
  STRIPE_WEBHOOK_SECRET: "whsec_preview",
});
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      yield* startApplication(config, { emailSender: sender, stripeGateway: gateway });
      process.stdout.write(
        "Local website API: http://127.0.0.1:3800; test inbox: http://127.0.0.1:3802\n",
      );
      yield* Effect.never;
    }),
  ),
  { signal: controller.signal },
).catch(() => undefined);
inbox.closeAllConnections();
inbox.close();
await rm(directory, { recursive: true, force: true });
