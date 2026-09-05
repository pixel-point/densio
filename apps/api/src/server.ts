import { Effect } from "effect";
import Stripe from "stripe";

import { startApplication } from "./application.ts";
import { makeStripeGateway } from "./billing/stripe-gateway.ts";
import { loadConfig } from "./config.ts";
import { makeConfiguredResendEmailSender } from "./email/resend-email-sender.ts";
import { validateProductionConfig } from "./runtime-config.ts";

const config = loadConfig(process.env);

const main = Effect.scoped(
  Effect.gen(function* () {
    yield* Effect.sync(() => validateProductionConfig(config));
    const application = yield* startApplication(config, {
      emailSender: makeConfiguredResendEmailSender(config.resendApiKey),
      stripeGateway: makeStripeGateway(new Stripe(config.stripeSecretKey)),
    });
    yield* Effect.sync(() => process.stdout.write(`Listening on ${application.url}\n`));
    yield* waitForShutdown;
  }),
);

const waitForShutdown = Effect.callback<void>((resume) => {
  const shutdown = () => resume(Effect.void);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return Effect.sync(() => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  });
});

Effect.runPromise(main).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Application startup failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
