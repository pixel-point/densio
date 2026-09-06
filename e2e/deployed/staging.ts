import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Stripe from "stripe";

import { taggedGmailAddress } from "./gmail.ts";
import {
  assertStripeTestKey,
  authenticate,
  compressAndVerify,
  gmailCredentialsFromEnvironment,
  requestCheckout,
  requiredEnvironment,
  waitForPlan,
} from "./journey.ts";

const run = async () => {
  const environment = process.env;
  const apiUrl = requiredEnvironment(environment, "DENSIO_SYNTHETIC_API_URL");
  const baseEmail = requiredEnvironment(environment, "DENSIO_SYNTHETIC_EMAIL");
  const email = taggedGmailAddress(baseEmail, `staging-${Date.now().toString(36)}`);
  const stripe = new Stripe(
    assertStripeTestKey(requiredEnvironment(environment, "DENSIO_SYNTHETIC_STRIPE_SECRET_KEY")),
  );
  const priceId = requiredEnvironment(environment, "DENSIO_SYNTHETIC_STRIPE_BASIC_PRICE_ID");
  const directory = await mkdtemp(join(tmpdir(), "densio-staging-synthetic-"));
  const credentialsPath = join(directory, "credentials.json");

  try {
    const user = await authenticate({
      websiteUrl: requiredEnvironment(environment, "DENSIO_SYNTHETIC_WEBSITE_URL"),
      apiUrl,
      credentialsPath,
      email,
      gmail: gmailCredentialsFromEnvironment(environment),
    });
    const checkoutStartedAt = Math.floor(Date.now() / 1_000);
    const checkoutUrl = await requestCheckout(apiUrl, credentialsPath);
    const session = await verifyCheckoutConfiguration(
      stripe,
      user.organizationId,
      priceId,
      checkoutStartedAt,
    );
    if (typeof session.customer !== "string") throw new Error("Checkout has no mapped customer.");
    const customer = { id: session.customer };
    await stripe.checkout.sessions.expire(session.id);

    try {
      const paymentMethod = await stripe.paymentMethods.attach("pm_card_visa", {
        customer: customer.id,
      });
      const subscription = await stripe.subscriptions.create({
        customer: customer.id,
        default_payment_method: paymentMethod.id,
        items: [{ price: priceId, quantity: 1 }],
        metadata: { densioSynthetic: "staging", organizationId: user.organizationId },
        payment_behavior: "error_if_incomplete",
      });
      if (subscription.status !== "active") {
        throw new Error(`Stripe created a ${subscription.status} synthetic subscription.`);
      }
      await waitForPlan(apiUrl, credentialsPath, "basic");
      const video = await compressAndVerify(apiUrl, credentialsPath, directory);
      return {
        apiUrl,
        checkoutHost: new URL(checkoutUrl).hostname,
        email,
        plan: "basic",
        stripeMode: "test",
        userId: user.id,
        organizationId: user.organizationId,
        video,
      };
    } finally {
      await stripe.customers.del(customer.id);
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

const verifyCheckoutConfiguration = async (
  stripe: Stripe,
  organizationId: string,
  priceId: string,
  createdAt: number,
) => {
  const sessions = await stripe.checkout.sessions.list({ created: { gte: createdAt }, limit: 10 });
  const session = sessions.data.find(
    (candidate) =>
      candidate.client_reference_id === organizationId &&
      candidate.metadata?.organizationId === organizationId,
  );
  if (session === undefined)
    throw new Error("Stripe did not create the requested Checkout session.");
  const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 10 });
  const configuredPrice = lineItems.data[0]?.price;
  const configuredPriceId =
    typeof configuredPrice === "string" ? configuredPrice : configuredPrice?.id;
  if (
    configuredPriceId !== priceId ||
    lineItems.data.length !== 1 ||
    lineItems.data[0]?.quantity !== 1
  ) {
    throw new Error("The staging Checkout session used the wrong Basic price.");
  }
  return session;
};

try {
  process.stdout.write(`${JSON.stringify({ ok: true, result: await run() })}\n`);
} catch (cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`${JSON.stringify({ message, ok: false })}\n`);
  process.exitCode = 1;
}
