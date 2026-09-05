import Stripe from "stripe";
import { Effect } from "effect";
import { expect, it } from "vitest";

import { InvalidStripeWebhook } from "../src/billing/billing-errors.ts";
import {
  makeStripeGateway,
  normalizeStripeSubscription,
  normalizeStripeSubscriptionStatus,
} from "../src/billing/stripe-gateway.ts";

const WEBHOOK_SECRET = "whsec_test_billing_signature";

it("verifies raw webhook bytes with Stripe and normalizes subscription data", async () => {
  const stripe = new Stripe("sk_test_billing_fixture");
  const gateway = makeStripeGateway(stripe);
  const payload = JSON.stringify(subscriptionEventFixture());
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: WEBHOOK_SECRET,
  });

  const event = await Effect.runPromise(
    gateway.parseWebhook({
      rawBody: Buffer.from(payload),
      signature,
      webhookSecret: WEBHOOK_SECRET,
    }),
  );

  expect(event).toEqual({
    eventId: "evt_subscription_updated",
    kind: "subscription-sync",
    subscriptionId: "sub_agent",
  });
});

it("normalizes the current Stripe subscription representation", () => {
  expect(normalizeStripeSubscription(subscriptionEventFixture().data.object)).toEqual({
    cancelAtPeriodEnd: false,
    currentPeriodEnd: 1_900_000_000_000,
    customerId: "cus_agent",
    priceId: "price_pro",
    status: "trialing",
    subscriptionId: "sub_agent",
    organizationId: "org-1",
  });
});

it("rejects a webhook signed with a different secret", async () => {
  const stripe = new Stripe("sk_test_billing_fixture");
  const gateway = makeStripeGateway(stripe);
  const payload = JSON.stringify(subscriptionEventFixture());
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: "whsec_wrong",
  });

  const error = await Effect.runPromise(
    Effect.flip(
      gateway.parseWebhook({
        rawBody: Buffer.from(payload),
        signature,
        webhookSecret: WEBHOOK_SECRET,
      }),
    ),
  );

  expect(error).toBeInstanceOf(InvalidStripeWebhook);
});

it.each([
  "active",
  "trialing",
  "past_due",
  "canceled",
  "unpaid",
  "incomplete",
  "incomplete_expired",
  "paused",
] as const)("normalizes Stripe subscription status %s", (status) => {
  expect(normalizeStripeSubscriptionStatus(status)).toBe(status);
});

it("rejects an unknown Stripe subscription status", () => {
  expect(() => normalizeStripeSubscriptionStatus("ACTIVE")).toThrow();
});

it.each([0, 2, undefined])("rejects a non-global subscription quantity %s", (quantity) => {
  const subscription = subscriptionEventFixture().data.object;
  expect(() =>
    normalizeStripeSubscription({
      ...subscription,
      items: { data: subscription.items.data.map((item) => ({ ...item, quantity })) },
    }),
  ).toThrow("quantity one");
});

const subscriptionEventFixture = () => ({
  api_version: null,
  created: 1_800_000_000,
  data: {
    object: {
      cancel_at_period_end: false,
      customer: "cus_agent",
      id: "sub_agent",
      items: {
        data: [
          {
            current_period_end: 1_900_000_000,
            quantity: 1,
            price: { id: "price_pro" },
          },
        ],
      },
      metadata: { organizationId: "org-1" },
      object: "subscription",
      status: "trialing",
    },
  },
  id: "evt_subscription_updated",
  livemode: false,
  object: "event",
  pending_webhooks: 1,
  request: null,
  type: "customer.subscription.updated",
});
