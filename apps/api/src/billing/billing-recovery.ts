import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import type { Database } from "../database/database.ts";
import { billingOperations, billingCheckoutAttempts } from "../database/schema.ts";
import { appendOrganizationAudit } from "../database/organization-audit-repository.ts";
import { organizationStorage } from "../organizations/organization-service.ts";
import { organizationFailure } from "../organizations/organization-errors.ts";
import { findBillingAccount } from "./billing-repository.ts";
import {
  billingBusy,
  completeBillingOperation,
  discardExpiredTransientOperations,
  requireBillingOperation,
  yieldBillingOperation,
  type BillingOperation,
} from "./billing-operation-repository.ts";
import { readCustomerRequest, recordCustomer, recordCheckoutState } from "./checkout-repository.ts";
import { loadCheckoutEvidence } from "./checkout-evidence.ts";
import { reconcileBillingContact } from "./billing-contact.ts";
import type { StripeGateway } from "./stripe-gateway.ts";

export const inspectBillingRecovery = (database: Database, organizationId: string) => {
  if (findBillingAccount(database, organizationId) === undefined)
    throw organizationFailure("ORGANIZATION_NOT_FOUND", "Organization not found.");
  const pending = database.db
    .select()
    .from(billingOperations)
    .where(eq(billingOperations.organizationId, organizationId))
    .get();
  return {
    organizationId,
    pending:
      pending === undefined
        ? null
        : {
            operation: pending.operation,
            operationId: pending.id,
            createdAt: pending.createdAt,
            leaseExpiresAt: pending.leaseExpiresAt,
            ...(pending.operation === "contact" ? { billingEmail: pending.requestKey } : {}),
            ...(pending.operation === "checkout" ? { idempotencyKey: pending.requestKey } : {}),
          },
  };
};

// This is an explicit platform-operator boundary, never an impersonated membership.
// Recovery may read existing financial resources; it cannot create replacements.
export const reconcileBillingRecovery = Effect.fn("Billing.operatorRecovery")(function* (
  database: Database,
  gateway: StripeGateway["Service"],
  input: { organizationId: string; operator: string; now: number },
) {
  const operation = yield* organizationStorage("acquire-operator-recovery", () =>
    database.db.transaction(
      (transaction) => {
        inspectBillingRecovery(database, input.organizationId);
        discardExpiredTransientOperations(transaction, input.organizationId, input.now);
        const current = transaction
          .select()
          .from(billingOperations)
          .where(eq(billingOperations.organizationId, input.organizationId))
          .get();
        if (current === undefined) return undefined;
        if (current.leaseExpiresAt > input.now)
          throw billingBusy(
            "The billing operation is still running. Retry after its lease expires.",
          );
        return transaction
          .update(billingOperations)
          .set({ leaseToken: randomUUID(), leaseExpiresAt: input.now + 60_000 })
          .where(eq(billingOperations.organizationId, input.organizationId))
          .returning()
          .get();
      },
      { behavior: "immediate" },
    ),
  );
  if (operation === undefined) return { organizationId: input.organizationId, reconciled: false };
  return yield* Effect.gen(function* () {
    const actor = { kind: "platform-operator" as const, name: input.operator };
    const correlationId = `operator:${operation.id}`;
    if (operation.operation === "contact") {
      const account = yield* organizationStorage("recovery-account", () =>
        findBillingAccount(database, input.organizationId),
      );
      if (account === undefined) return yield* billingBusy("The billing account is missing.");
      yield* reconcileBillingContact(database, gateway, {
        operation,
        customerId: account.customerId,
        actor,
        correlationId,
        now: input.now,
      });
    }
    if (operation.operation === "checkout")
      yield* recoverPersistedCheckout(database, gateway, {
        operation,
        actor,
        correlationId,
        now: input.now,
      });
    return { organizationId: input.organizationId, reconciled: true };
  }).pipe(
    Effect.ensuring(
      organizationStorage("yield-operator-recovery", () =>
        yieldBillingOperation(database, operation),
      ).pipe(Effect.orDie),
    ),
  );
});

const recoverPersistedCheckout = Effect.fn("Billing.recoverPersistedCheckout")(function* (
  database: Database,
  gateway: StripeGateway["Service"],
  input: {
    operation: BillingOperation;
    actor: { kind: "platform-operator"; name: string };
    correlationId: string;
    now: number;
  },
) {
  const { operation } = input;
  const attempt = yield* organizationStorage("read-recovery-attempt", () =>
    database.db
      .select()
      .from(billingCheckoutAttempts)
      .where(
        and(
          eq(billingCheckoutAttempts.organizationId, operation.organizationId),
          eq(billingCheckoutAttempts.idempotencyKey, operation.requestKey),
        ),
      )
      .get(),
  );
  if (attempt === undefined) {
    // No provider call is possible before prepareCheckout persists the attempt.
    yield* organizationStorage("release-unused-checkout", () =>
      database.db.transaction((transaction) => completeBillingOperation(transaction, operation)),
    );
    return;
  }
  const request = yield* organizationStorage("read-recovery-customer", () =>
    readCustomerRequest(database, operation.organizationId),
  );
  const customerId =
    request.customerId ??
    (yield* gateway.findCustomer(operation.organizationId, request.billingEmail));
  if (customerId === null)
    return yield* billingBusy(
      "No matching provider customer was found. Keep this attempt blocked and investigate with the provider; do not create a replacement.",
    );
  yield* organizationStorage("record-recovery-customer", () =>
    recordCustomer(database, operation.organizationId, customerId, input.now),
  );
  const session =
    attempt.sessionId === null
      ? yield* gateway.findCheckoutSession(customerId, attempt.id)
      : yield* gateway.retrieveCheckoutSession(attempt.sessionId);
  if (session === null)
    return yield* billingBusy(
      "No matching checkout evidence was found. Keep this attempt blocked and investigate with the provider; do not create a replacement.",
    );
  const evidence = yield* loadCheckoutEvidence(database, gateway, session, input.now);
  yield* organizationStorage("commit-checkout-recovery", () =>
    database.db.transaction(
      (transaction) => {
        requireBillingOperation(transaction, operation);
        recordCheckoutState(transaction, attempt, evidence);
        completeBillingOperation(transaction, operation);
        if (attempt.sessionId === null)
          appendOrganizationAudit(transaction, {
            organizationId: operation.organizationId,
            kind: "billing-checkout-created",
            actor: input.actor,
            targetId: session.id,
            correlationId: input.correlationId,
            now: input.now,
          });
      },
      { behavior: "immediate" },
    ),
  );
});
