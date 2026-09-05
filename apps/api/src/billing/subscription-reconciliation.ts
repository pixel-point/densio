import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import type { Database, DatabaseTransaction } from "../database/database.ts";
import { billingReconciliations } from "../database/schema.ts";
import { organizationStorage } from "../organizations/organization-service.ts";
import { BillingWebhookUnmatched } from "./billing-errors.ts";
import { applyBillingWebhook } from "./billing-repository.ts";
import type { StripeGateway } from "./stripe-gateway.ts";

// A later-started authoritative read supersedes earlier in-flight reads. Claims
// survive restart and work across SQLite connections; no transaction spans I/O.
export const reconcileSubscription = Effect.fn("Billing.reconcileSubscription")(function* (
  database: Database,
  gateway: StripeGateway["Service"],
  input: { subscriptionId: string; eventId: string; now: number },
) {
  const evidence = yield* loadSubscriptionEvidence(database, gateway, input);
  const outcome = yield* organizationStorage("apply-subscription-reconciliation", () =>
    database.db.transaction((transaction) => applySubscriptionEvidence(transaction, evidence), {
      behavior: "immediate",
    }),
  );
  if (outcome.kind === "unmatched")
    return yield* new BillingWebhookUnmatched({ eventId: input.eventId });
  return outcome;
});

export const loadSubscriptionEvidence = Effect.fn("Billing.loadSubscriptionEvidence")(function* (
  database: Database,
  gateway: StripeGateway["Service"],
  input: { subscriptionId: string; eventId: string; now: number },
) {
  const claimId = randomUUID();
  yield* organizationStorage("claim-subscription-reconciliation", () =>
    database.db
      .insert(billingReconciliations)
      .values({ subscriptionId: input.subscriptionId, claimId })
      .onConflictDoUpdate({ target: billingReconciliations.subscriptionId, set: { claimId } })
      .run(),
  );
  const subscription = yield* gateway.retrieveSubscription(input.subscriptionId);
  return { ...input, claimId, subscription };
});

export type SubscriptionEvidence = Effect.Success<ReturnType<typeof loadSubscriptionEvidence>>;

export const applySubscriptionEvidence = (
  transaction: DatabaseTransaction,
  evidence: SubscriptionEvidence,
) => {
  const claim = transaction
    .select()
    .from(billingReconciliations)
    .where(eq(billingReconciliations.subscriptionId, evidence.subscriptionId))
    .get();
  if (
    claim?.claimId !== evidence.claimId ||
    evidence.subscription.subscriptionId !== evidence.subscriptionId
  )
    return { kind: "unmatched" as const };
  return applyBillingWebhook(
    transaction,
    { ...evidence.subscription, eventId: evidence.eventId, kind: "subscription-upsert" },
    evidence.now,
  );
};
