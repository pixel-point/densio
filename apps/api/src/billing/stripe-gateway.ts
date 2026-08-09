import { SubscriptionStatusSchema } from "@densio/shared";
import { Context, Effect, Schema } from "effect";
import Stripe from "stripe";

import type { StripeSubscriptionStatus } from "../auth/entitlements.ts";
import { InvalidStripeWebhook, StripeGatewayError } from "./billing-errors.ts";

const decodeStripeSubscriptionStatus = Schema.decodeUnknownSync(SubscriptionStatusSchema);

export interface HostedStripeSession {
  readonly id: string;
  readonly url: string;
}

export interface StripeSubscriptionState {
  readonly cancelAtPeriodEnd: boolean;
  readonly currentPeriodEnd: number;
  readonly customerId: string;
  readonly priceId: string;
  readonly status: StripeSubscriptionStatus;
  readonly subscriptionId: string;
  readonly userId: string | null;
}

interface StripeSubscriptionInput {
  readonly cancel_at_period_end: boolean;
  readonly customer: string | { readonly id: string } | null;
  readonly id: string;
  readonly items: {
    readonly data: ReadonlyArray<{
      readonly current_period_end: number;
      readonly price: { readonly id: string };
    }>;
  };
  readonly metadata: Readonly<Record<string, string>>;
  readonly status: unknown;
}

export type BillingWebhookEvent =
  | {
      readonly eventId: string;
      readonly kind: "customer-map";
      readonly customerId: string;
      readonly userId: string;
    }
  | {
      readonly eventId: string;
      readonly kind: "subscription-sync";
      readonly subscriptionId: string;
    }
  | { readonly eventId: string; readonly kind: "ignored" };

export type BillingEvent =
  | Exclude<BillingWebhookEvent, { readonly kind: "subscription-sync" }>
  | ({ readonly eventId: string; readonly kind: "subscription-upsert" } & StripeSubscriptionState);

export interface ParseWebhookInput {
  readonly rawBody: string | Uint8Array;
  readonly signature: string;
  readonly webhookSecret: string;
}

export interface StripeGatewayDefinition {
  readonly createCheckoutSession: (
    params: Stripe.Checkout.SessionCreateParams,
  ) => Effect.Effect<HostedStripeSession, StripeGatewayError>;
  readonly createPortalSession: (
    params: Stripe.BillingPortal.SessionCreateParams,
  ) => Effect.Effect<HostedStripeSession, StripeGatewayError>;
  readonly parseWebhook: (
    input: ParseWebhookInput,
  ) => Effect.Effect<BillingWebhookEvent, InvalidStripeWebhook>;
  readonly retrieveSubscription: (
    subscriptionId: string,
  ) => Effect.Effect<StripeSubscriptionState, StripeGatewayError>;
}

export class StripeGateway extends Context.Service<StripeGateway, StripeGatewayDefinition>()(
  "densio/billing/StripeGateway",
) {}

export const makeStripeGateway = (stripe: Stripe) =>
  StripeGateway.of({
    createCheckoutSession: Effect.fn("StripeGateway.createCheckoutSession")((params) =>
      Effect.tryPromise({
        catch: (cause) =>
          new StripeGatewayError({
            cause,
            operation: "create-checkout-session",
          }),
        try: async () => {
          const session = await stripe.checkout.sessions.create(params);
          return { id: session.id, url: requireValue(session.url, "Checkout URL") };
        },
      }),
    ),
    createPortalSession: Effect.fn("StripeGateway.createPortalSession")((params) =>
      Effect.tryPromise({
        catch: (cause) =>
          new StripeGatewayError({
            cause,
            operation: "create-portal-session",
          }),
        try: async () => {
          const session = await stripe.billingPortal.sessions.create(params);
          return { id: session.id, url: session.url };
        },
      }),
    ),
    parseWebhook: Effect.fn("StripeGateway.parseWebhook")((input) =>
      Effect.try({
        catch: (cause) => new InvalidStripeWebhook({ cause }),
        try: () =>
          normalizeStripeEvent(
            stripe.webhooks.constructEvent(input.rawBody, input.signature, input.webhookSecret),
          ),
      }),
    ),
    retrieveSubscription: Effect.fn("StripeGateway.retrieveSubscription")((subscriptionId) =>
      Effect.tryPromise({
        catch: (cause) => new StripeGatewayError({ cause, operation: "retrieve-subscription" }),
        try: async () =>
          normalizeStripeSubscription(await stripe.subscriptions.retrieve(subscriptionId)),
      }),
    ),
  });

export const normalizeStripeSubscriptionStatus = (status: unknown): StripeSubscriptionStatus =>
  decodeStripeSubscriptionStatus(status);

const normalizeStripeEvent = (event: Stripe.Event): BillingWebhookEvent => {
  switch (event.type) {
    case "checkout.session.completed":
      return normalizeCheckoutEvent(event.id, event.data.object);
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      return {
        eventId: event.id,
        kind: "subscription-sync",
        subscriptionId: event.data.object.id,
      };
    default:
      return { eventId: event.id, kind: "ignored" };
  }
};

const normalizeCheckoutEvent = (
  eventId: string,
  session: Stripe.Checkout.Session,
): BillingWebhookEvent => ({
  customerId: requireValue(getExpandableId(session.customer), "Customer ID"),
  eventId,
  kind: "customer-map",
  userId: requireValue(session.metadata?.userId ?? session.client_reference_id, "User ID"),
});

export const normalizeStripeSubscription = (
  subscription: StripeSubscriptionInput,
): StripeSubscriptionState => {
  const item = requireValue(subscription.items.data[0], "Subscription item");

  return {
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    currentPeriodEnd:
      Math.max(...subscription.items.data.map(({ current_period_end }) => current_period_end)) *
      1_000,
    customerId: requireValue(getExpandableId(subscription.customer), "Customer ID"),
    priceId: item.price.id,
    status: normalizeStripeSubscriptionStatus(subscription.status),
    subscriptionId: subscription.id,
    userId: subscription.metadata.userId ?? null,
  };
};

const getExpandableId = (value: string | { readonly id: string } | null) =>
  typeof value === "string" ? value : (value?.id ?? null);

const requireValue = <Value>(value: Value | null | undefined, name: string) => {
  if (value === null || value === undefined) throw new Error(`Missing ${name}`);
  return value;
};
