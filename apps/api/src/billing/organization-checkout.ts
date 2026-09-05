import { Effect } from "effect";
import type { PaidPlan } from "@densio/shared";
import type { Database } from "../database/database.ts";
import {
  authorizeOrganization,
  type OrganizationActor,
} from "../organizations/organization-access.ts";
import { organizationStorage } from "../organizations/organization-service.ts";
import type { BillingConfig } from "./billing-service.ts";
import type { StripeGateway } from "./stripe-gateway.ts";
import {
  acquireBillingOperation,
  billingBusy,
  completeBillingOperation,
  requireBillingOperation,
  requireSafeProviderRetry,
  yieldBillingOperation,
  type BillingOperation,
} from "./billing-operation-repository.ts";
import {
  finishCheckout,
  prepareCheckout,
  readCustomerRequest,
  readLiveCheckout,
  recordCheckoutState,
  recordCustomer,
  type CheckoutAttempt,
} from "./checkout-repository.ts";
import { loadCheckoutEvidence } from "./checkout-evidence.ts";

export const makeOrganizationCheckout = (
  database: Database,
  gateway: StripeGateway["Service"],
  now: () => number,
) =>
  Effect.fn("Billing.createCheckout")(function* (input: {
    actor: OrganizationActor;
    config: BillingConfig;
    plan: PaidPlan;
    idempotencyKey: string;
    correlationId: string;
  }) {
    const operation = yield* organizationStorage("acquire-checkout", () =>
      acquireBillingOperation(database, {
        actor: input.actor,
        operation: "checkout",
        requestKey: input.idempotencyKey,
        now: now(),
      }),
    );
    const program = Effect.gen(function* () {
      yield* reconcileLiveCheckout(database, gateway, operation, now());
      const attempt = yield* organizationStorage("prepare-checkout", () =>
        prepareCheckout(database, { ...input, operation, now: now() }),
      ).pipe(
        Effect.tapError(() =>
          organizationStorage("release-unused-billing-operation", () =>
            database.db.transaction((transaction) =>
              completeBillingOperation(transaction, operation),
            ),
          ),
        ),
      );
      const customerId = yield* ensureCustomer(database, gateway, attempt.organizationId, now());
      const session = yield* recoverCheckout(gateway, attempt, customerId, now());
      const evidence = yield* loadCheckoutEvidence(database, gateway, session, now());
      yield* organizationStorage("finish-checkout", () =>
        finishCheckout(database, { ...input, operation, attempt, evidence, now: now() }),
      );
      // A request may outlive an ownership transfer. Persist provider evidence, but
      // never disclose the hosted bearer URL to a former owner.
      yield* organizationStorage("authorize-checkout-result", () =>
        authorizeOrganization(database.db, input.actor, "billing-write"),
      );
      if (session.status !== "open" || session.url === null || session.expiresAt <= now())
        return yield* billingBusy(
          "This checkout is no longer open. Use billing status or the portal; an expired attempt needs a new idempotency key.",
        );
      return {
        organizationId: attempt.organizationId,
        kind: "checkout" as const,
        url: session.url,
        expiresAt: new Date(session.expiresAt).toISOString(),
      };
    });
    return yield* program.pipe(
      Effect.ensuring(
        organizationStorage("yield-checkout-operation", () =>
          yieldBillingOperation(database, operation),
        ).pipe(Effect.orDie),
      ),
    );
  });

const ensureCustomer = Effect.fn("Billing.ensureCustomer")(function* (
  database: Database,
  gateway: StripeGateway["Service"],
  organizationId: string,
  now: number,
) {
  const request = yield* organizationStorage("read-customer-request", () =>
    readCustomerRequest(database, organizationId),
  );
  if (request.customerId !== null) return request.customerId;
  const existing = yield* gateway.findCustomer(organizationId, request.billingEmail);
  const customerId =
    existing ??
    (yield* Effect.gen(function* () {
      yield* organizationStorage("customer-retry-window", () =>
        requireSafeProviderRetry(request.createdAt, now),
      );
      return yield* gateway.createCustomer(
        { email: request.billingEmail, metadata: { organizationId } },
        `densio:customer:${organizationId}`,
      );
    }));
  yield* organizationStorage("record-customer", () =>
    recordCustomer(database, organizationId, customerId, now),
  );
  return customerId;
});

const recoverCheckout = Effect.fn("Billing.recoverCheckout")(function* (
  gateway: StripeGateway["Service"],
  attempt: CheckoutAttempt,
  customerId: string,
  now: number,
) {
  const existing =
    attempt.sessionId === null
      ? yield* gateway.findCheckoutSession(customerId, attempt.id)
      : yield* gateway.retrieveCheckoutSession(attempt.sessionId);
  if (existing !== null) return existing;
  yield* organizationStorage("checkout-retry-window", () =>
    requireSafeProviderRetry(attempt.createdAt, now),
  );
  return yield* gateway.createCheckoutSession(
    {
      cancel_url: attempt.cancelUrl,
      success_url: attempt.successUrl,
      client_reference_id: attempt.organizationId,
      customer: customerId,
      line_items: [{ price: attempt.priceId, quantity: 1 }],
      metadata: { organizationId: attempt.organizationId, attemptId: attempt.id },
      mode: "subscription",
      subscription_data: { metadata: { organizationId: attempt.organizationId } },
    },
    `densio:checkout:${attempt.id}`,
  );
});

export const reconcileLiveCheckout = Effect.fn("Billing.reconcileLiveCheckout")(function* (
  database: Database,
  gateway: StripeGateway["Service"],
  operation: BillingOperation,
  now: number,
) {
  const attempt = yield* organizationStorage("read-live-checkout", () =>
    readLiveCheckout(database, operation.organizationId),
  );
  if (attempt?.sessionId === null || attempt === undefined) return;
  const session = yield* gateway.retrieveCheckoutSession(attempt.sessionId);
  const evidence = yield* loadCheckoutEvidence(database, gateway, session, now);
  yield* organizationStorage("record-checkout-state", () =>
    database.db.transaction(
      (transaction) => {
        requireBillingOperation(transaction, operation);
        recordCheckoutState(transaction, attempt, evidence);
      },
      { behavior: "immediate" },
    ),
  );
});
