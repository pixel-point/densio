import Stripe from "stripe";
import { Effect } from "effect";
import { expect, it } from "vitest";

import { InvalidStripeWebhook } from "../src/billing/billing-errors.ts";
import {
  makeStripeGateway,
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
    cancelAtPeriodEnd: false,
    currentPeriodEnd: 1_900_000_000_000,
    customerId: "cus_agent",
    eventId: "evt_subscription_updated",
    kind: "subscription-upsert",
    priceId: "price_pro",
    status: "trialing",
    subscriptionId: "sub_agent",
    userId: "user-1",
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
            price: { id: "price_pro" },
          },
        ],
      },
      metadata: { userId: "user-1" },
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
