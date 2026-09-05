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

export interface StripeCheckoutState {
  readonly id: string;
  readonly url: string | null;
  readonly status: "open" | "complete" | "expired";
  readonly expiresAt: number;
  readonly customerId: string;
  readonly subscriptionId: string | null;
  readonly organizationId: string;
  readonly attemptId: string;
}

export interface StripeSubscriptionState {
  readonly cancelAtPeriodEnd: boolean;
  readonly currentPeriodEnd: number;
  readonly customerId: string;
  readonly priceId: string;
  readonly status: StripeSubscriptionStatus;
  readonly subscriptionId: string;
  readonly organizationId: string | null;
}

interface StripeSubscriptionInput {
  readonly cancel_at_period_end: boolean;
  readonly customer: string | { readonly id: string } | null;
  readonly id: string;
  readonly items: {
    readonly data: ReadonlyArray<{
      readonly current_period_end: number;
      readonly quantity?: number | undefined;
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
      readonly organizationId: string;
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
  readonly retrieveCustomer: (customerId: string) => Effect.Effect<
    {
      customerId: string;
      organizationId: string | null;
      email: string | null;
    } | null,
    StripeGatewayError
  >;
  readonly listCustomerSubscriptions: (
    customerId: string,
  ) => Effect.Effect<readonly StripeSubscriptionState[], StripeGatewayError>;
  readonly createCustomer: (
    params: Stripe.CustomerCreateParams,
    idempotencyKey: string,
  ) => Effect.Effect<string, StripeGatewayError>;
  readonly findCustomer: (
    organizationId: string,
    email: string,
  ) => Effect.Effect<string | null, StripeGatewayError>;
  readonly updateCustomer: (
    customerId: string,
    email: string,
    idempotencyKey: string,
  ) => Effect.Effect<void, StripeGatewayError>;
  readonly createCheckoutSession: (
    params: Stripe.Checkout.SessionCreateParams,
    idempotencyKey: string,
  ) => Effect.Effect<StripeCheckoutState, StripeGatewayError>;
  readonly retrieveCheckoutSession: (
    sessionId: string,
  ) => Effect.Effect<StripeCheckoutState, StripeGatewayError>;
  readonly findCheckoutSession: (
    customerId: string,
    attemptId: string,
  ) => Effect.Effect<StripeCheckoutState | null, StripeGatewayError>;
  readonly createPortalSession: (
    params: Stripe.BillingPortal.SessionCreateParams,
    idempotencyKey: string,
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
    retrieveCustomer: (customerId) =>
      stripeRequest("retrieve-customer", async () => {
        const customer = await stripe.customers.retrieve(customerId);
        return customer.deleted
          ? null
          : {
              customerId: customer.id,
              organizationId: customer.metadata.organizationId ?? null,
              email: customer.email,
            };
      }),
    listCustomerSubscriptions: (customerId) =>
      stripeRequest("list-customer-subscriptions", async () => {
        const subscriptions = await stripe.subscriptions
          .list({ customer: customerId, status: "all", limit: 100 })
          .autoPagingToArray({ limit: 10_000 });
        if (subscriptions.length >= 10_000)
          throw new Error("Subscription reconciliation limit reached.");
        return subscriptions.map(normalizeStripeSubscription);
      }),
    createCustomer: (params, idempotencyKey) =>
      stripeRequest(
        "create-customer",
        async () => (await stripe.customers.create(params, { idempotencyKey })).id,
      ),
    findCustomer: (organizationId, email) =>
      stripeRequest("find-customer", async () => {
        const customers = await stripe.customers
          .list({ email, limit: 100 })
          .autoPagingToArray({ limit: 10_000 });
        return (
          uniqueReconciledObject(
            customers,
            (customer) => customer.metadata.organizationId === organizationId,
          )?.id ?? null
        );
      }),
    updateCustomer: (customerId, email, idempotencyKey) =>
      stripeRequest("update-customer", async () => {
        await stripe.customers.update(customerId, { email }, { idempotencyKey });
      }),
    createCheckoutSession: (params, idempotencyKey) =>
      stripeRequest("create-checkout-session", async () =>
        normalizeCheckoutSession(await stripe.checkout.sessions.create(params, { idempotencyKey })),
      ),
    retrieveCheckoutSession: (sessionId) =>
      stripeRequest("retrieve-checkout-session", async () =>
        normalizeCheckoutSession(await stripe.checkout.sessions.retrieve(sessionId)),
      ),
    findCheckoutSession: (customerId, attemptId) =>
      stripeRequest("find-checkout-session", async () => {
        const sessions = await stripe.checkout.sessions
          .list({ customer: customerId, limit: 100 })
          .autoPagingToArray({ limit: 10_000 });
        const session = uniqueReconciledObject(
          sessions,
          (candidate) => candidate.metadata?.attemptId === attemptId,
        );
        return session === undefined ? null : normalizeCheckoutSession(session);
      }),
    createPortalSession: (params, idempotencyKey) =>
      stripeRequest("create-portal-session", async () => {
        const session = await stripe.billingPortal.sessions.create(params, { idempotencyKey });
        return { id: session.id, url: session.url };
      }),
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

const stripeRequest = <Value>(operation: string, evaluate: () => Promise<Value>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new StripeGatewayError({ cause, operation }),
  });
const uniqueReconciledObject = <Value>(
  values: readonly Value[],
  matches: (value: Value) => boolean,
) => {
  if (values.length >= 10_000)
    throw new Error("Provider reconciliation requires an operator: listing limit reached.");
  const candidates = values.filter(matches);
  if (candidates.length > 1) throw new Error("Multiple provider objects match one billing intent.");
  return candidates[0];
};
const normalizeCheckoutSession = (session: Stripe.Checkout.Session): StripeCheckoutState => ({
  id: session.id,
  url: session.url,
  status: requireValue(session.status, "Checkout status"),
  expiresAt: session.expires_at * 1_000,
  customerId: requireValue(getExpandableId(session.customer), "Customer ID"),
  subscriptionId: getExpandableId(session.subscription),
  organizationId: checkoutOrganizationId(session),
  attemptId: requireValue(session.metadata?.attemptId, "Checkout attempt ID"),
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
  organizationId: checkoutOrganizationId(session),
});

const checkoutOrganizationId = (session: Stripe.Checkout.Session) => {
  const organizationId = requireValue(session.metadata?.organizationId, "Organization ID");
  if (organizationId !== session.client_reference_id)
    throw new Error("Checkout organization metadata mismatch.");
  return organizationId;
};

export const normalizeStripeSubscription = (
  subscription: StripeSubscriptionInput,
): StripeSubscriptionState => {
  const item = requireValue(subscription.items.data[0], "Subscription item");
  if (subscription.items.data.length !== 1)
    throw new Error("Organization subscriptions require one item.");
  if (item.quantity !== 1) throw new Error("Organization subscriptions require quantity one.");

  return {
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    currentPeriodEnd:
      Math.max(...subscription.items.data.map(({ current_period_end }) => current_period_end)) *
      1_000,
    customerId: requireValue(getExpandableId(subscription.customer), "Customer ID"),
    priceId: item.price.id,
    status: normalizeStripeSubscriptionStatus(subscription.status),
    subscriptionId: subscription.id,
    organizationId: subscription.metadata.organizationId ?? null,
  };
};

const getExpandableId = (value: string | { readonly id: string } | null) =>
  typeof value === "string" ? value : (value?.id ?? null);

const requireValue = <Value>(value: Value | null | undefined, name: string) => {
  if (value === null || value === undefined) throw new Error(`Missing ${name}`);
  return value;
};
