import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { Database } from "../database/database.ts";
import { billingBusy } from "./billing-operation-repository.ts";
import type { StripeCheckoutState, StripeGateway } from "./stripe-gateway.ts";
import { loadSubscriptionEvidence } from "./subscription-reconciliation.ts";

// Completion is not durable until the corresponding subscription can be applied
// in the same transaction. An unavailable provider must leave the attempt live.
export const loadCheckoutEvidence = Effect.fn("Billing.loadCheckoutEvidence")(function* (
  database: Database,
  gateway: StripeGateway["Service"],
  session: StripeCheckoutState,
  now: number,
) {
  if (session.status !== "complete") return { session, subscription: null };
  if (session.subscriptionId === null)
    return yield* billingBusy(
      "Completed checkout has no subscription evidence. Retry reconciliation.",
    );
  const subscription = yield* loadSubscriptionEvidence(database, gateway, {
    subscriptionId: session.subscriptionId,
    eventId: `checkout-reconcile:${randomUUID()}`,
    now,
  });
  return { session, subscription };
});

export type CheckoutEvidence = Effect.Success<ReturnType<typeof loadCheckoutEvidence>>;
