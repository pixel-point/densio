import { billingReturnUrl } from "./billing-return-url.ts";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { PaidPlan } from "@densio/shared";
import type { Database, DatabaseTransaction } from "../database/database.ts";
import {
  billingCheckoutAttempts,
  billingCustomerRequests,
  stripeCustomers,
  stripeSubscriptions,
} from "../database/schema.ts";
import {
  authorizeOrganization,
  type OrganizationActor,
} from "../organizations/organization-access.ts";
import { organizationFailure } from "../organizations/organization-errors.ts";
import {
  billingBusy,
  completeBillingOperation,
  requireBillingOperation,
  type BillingOperation,
} from "./billing-operation-repository.ts";
import { appendOrganizationAudit } from "../database/organization-audit-repository.ts";
import type { BillingConfig } from "./billing-service.ts";
import type { CheckoutEvidence } from "./checkout-evidence.ts";
import { applySubscriptionEvidence } from "./subscription-reconciliation.ts";

export type CheckoutAttempt = typeof billingCheckoutAttempts.$inferSelect;
export const readLiveCheckout = (database: Database, organizationId: string) =>
  database.db
    .select()
    .from(billingCheckoutAttempts)
    .where(
      and(
        eq(billingCheckoutAttempts.organizationId, organizationId),
        inArray(billingCheckoutAttempts.state, ["creating", "open"]),
      ),
    )
    .get();

export const prepareCheckout = (
  database: Database,
  input: {
    actor: OrganizationActor;
    plan: PaidPlan;
    idempotencyKey: string;
    config: BillingConfig;
    now: number;
    operation: BillingOperation;
  },
) =>
  database.db.transaction(
    (transaction) => {
      const access = authorizeOrganization(transaction, input.actor, "billing-write");
      requireBillingOperation(transaction, input.operation);
      const previous = transaction
        .select()
        .from(billingCheckoutAttempts)
        .where(
          and(
            eq(billingCheckoutAttempts.organizationId, input.actor.organizationId),
            eq(billingCheckoutAttempts.idempotencyKey, input.idempotencyKey),
          ),
        )
        .get();
      if (previous !== undefined) {
        if (previous.plan !== input.plan)
          throw organizationFailure(
            "IDEMPOTENCY_CONFLICT",
            "This organization checkout key identifies a different plan.",
          );
        return previous;
      }
      const subscription = transaction
        .select()
        .from(stripeSubscriptions)
        .where(
          and(
            eq(stripeSubscriptions.organizationId, input.actor.organizationId),
            notInArray(stripeSubscriptions.status, ["canceled", "incomplete_expired"]),
          ),
        )
        .get();
      if (subscription !== undefined)
        throw billingBusy("This organization already has a subscription. Use its billing portal.");
      if (readLiveCheckout(database, input.actor.organizationId) !== undefined)
        throw billingBusy(
          "This organization already has an open or unresolved checkout. Resume that attempt.",
        );
      transaction
        .insert(billingCustomerRequests)
        .values({
          organizationId: input.actor.organizationId,
          billingEmail: access.organization.billingEmail,
          createdAt: input.now,
        })
        .onConflictDoNothing()
        .run();
      return transaction
        .insert(billingCheckoutAttempts)
        .values({
          id: randomUUID(),
          organizationId: input.actor.organizationId,
          idempotencyKey: input.idempotencyKey,
          plan: input.plan,
          priceId: input.config.priceIds[input.plan],
          cancelUrl: billingReturnUrl(input.config.checkoutCancelUrl, input.actor.organizationId),
          successUrl: billingReturnUrl(input.config.checkoutSuccessUrl, input.actor.organizationId),
          state: "creating",
          createdAt: input.now,
        })
        .returning()
        .get();
    },
    { behavior: "immediate" },
  );

export const recordCheckoutState = (
  transaction: DatabaseTransaction,
  attempt: CheckoutAttempt,
  evidence: CheckoutEvidence,
) => {
  const { session, subscription } = evidence;
  const customer = transaction
    .select()
    .from(stripeCustomers)
    .where(eq(stripeCustomers.organizationId, attempt.organizationId))
    .get();
  if (
    session.organizationId !== attempt.organizationId ||
    session.attemptId !== attempt.id ||
    customer?.customerId !== session.customerId ||
    (attempt.sessionId !== null && attempt.sessionId !== session.id)
  )
    throw billingBusy("The provider checkout does not match the persisted organization attempt.");
  if (session.status === "complete") {
    if (
      subscription === null ||
      subscription.subscriptionId !== session.subscriptionId ||
      subscription.subscription.customerId !== session.customerId ||
      subscription.subscription.organizationId !== attempt.organizationId ||
      applySubscriptionEvidence(transaction, subscription).kind === "unmatched"
    )
      throw billingBusy(
        "Checkout subscription evidence is missing, mismatched, or superseded. Retry reconciliation.",
      );
  }
  transaction
    .update(billingCheckoutAttempts)
    .set({ state: session.status, sessionId: session.id, expiresAt: session.expiresAt })
    .where(eq(billingCheckoutAttempts.id, attempt.id))
    .run();
};

export const readCustomerRequest = (database: Database, organizationId: string) => {
  const request = database.db
    .select()
    .from(billingCustomerRequests)
    .where(eq(billingCustomerRequests.organizationId, organizationId))
    .get();
  if (request === undefined) throw new Error("Checkout customer request is missing.");
  return {
    ...request,
    customerId:
      database.db
        .select()
        .from(stripeCustomers)
        .where(eq(stripeCustomers.organizationId, organizationId))
        .get()?.customerId ?? null,
  };
};

export const recordCustomer = (
  database: Database,
  organizationId: string,
  customerId: string,
  now: number,
) => {
  database.db
    .insert(stripeCustomers)
    .values({ organizationId, customerId, createdAt: now })
    .onConflictDoNothing({ target: stripeCustomers.organizationId })
    .run();
  if (readCustomerRequest(database, organizationId).customerId !== customerId)
    throw billingBusy(
      "The provider customer conflicts with this organization's persisted billing account.",
    );
};

export const finishCheckout = (
  database: Database,
  input: {
    actor: OrganizationActor;
    operation: BillingOperation;
    attempt: CheckoutAttempt;
    evidence: CheckoutEvidence;
    now: number;
    correlationId: string;
  },
) =>
  database.db.transaction(
    (transaction) => {
      requireBillingOperation(transaction, input.operation);
      recordCheckoutState(transaction, input.attempt, input.evidence);
      completeBillingOperation(transaction, input.operation);
      if (input.attempt.sessionId === null)
        appendOrganizationAudit(transaction, {
          organizationId: input.actor.organizationId,
          actor: { kind: "user", userId: input.actor.userId },
          kind: "billing-checkout-created",
          targetId: input.evidence.session.id,
          now: input.now,
          correlationId: input.correlationId,
        });
    },
    { behavior: "immediate" },
  );
