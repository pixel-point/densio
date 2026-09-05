import type { OrganizationAuditActor } from "@densio/shared";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import type { Database } from "../database/database.ts";
import { appendOrganizationAudit } from "../database/organization-audit-repository.ts";
import { organizations } from "../database/schema.ts";
import { organizationStorage } from "../organizations/organization-service.ts";
import {
  billingBusy,
  completeBillingOperation,
  type BillingOperation,
} from "./billing-operation-repository.ts";
import type { StripeGateway } from "./stripe-gateway.ts";

// Contact intent is the normalized email, persisted in requestKey. Unlike a
// checkout creation, setting the same desired email is safe beyond 24 hours.
export const reconcileBillingContact = Effect.fn("Billing.reconcileContact")(function* (
  database: Database,
  gateway: StripeGateway["Service"],
  input: {
    operation: BillingOperation;
    customerId: string | null;
    actor: OrganizationAuditActor;
    correlationId: string;
    now: number;
  },
) {
  const { operation } = input;
  if (operation.operation !== "contact") return yield* billingBusy("Not a contact operation.");
  const billingEmail = operation.requestKey;
  if (input.customerId !== null) {
    const customer = yield* gateway.retrieveCustomer(input.customerId);
    if (
      customer?.customerId !== input.customerId ||
      customer.organizationId !== operation.organizationId
    )
      return yield* billingBusy("Billing customer evidence does not match this organization.");
    if (customer.email !== billingEmail)
      yield* gateway.updateCustomer(
        input.customerId,
        billingEmail,
        `densio:contact:${operation.id}:${Math.floor((input.now - operation.createdAt) / 86_400_000)}`,
      );
  }
  yield* organizationStorage("record-billing-contact", () =>
    database.db.transaction(
      (transaction) => {
        completeBillingOperation(transaction, operation);
        transaction
          .update(organizations)
          .set({ billingEmail, updatedAt: input.now })
          .where(eq(organizations.id, operation.organizationId))
          .run();
        appendOrganizationAudit(transaction, {
          organizationId: operation.organizationId,
          kind: "billing-contact-changed",
          actor: input.actor,
          targetId: operation.organizationId,
          now: input.now,
          correlationId: input.correlationId,
        });
      },
      { behavior: "immediate" },
    ),
  );
  return { organizationId: operation.organizationId, billingEmail };
});
