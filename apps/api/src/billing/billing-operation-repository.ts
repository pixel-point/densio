import { randomUUID } from "node:crypto";
import { and, eq, inArray, lte } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../database/database.ts";
import { billingOperations } from "../database/schema.ts";
import {
  authorizeOrganization,
  type OrganizationActor,
} from "../organizations/organization-access.ts";
import { organizationFailure } from "../organizations/organization-errors.ts";

export const billingBusy = (detail: string) =>
  organizationFailure("ORGANIZATION_BILLING_BUSY", detail);
export type BillingOperation = typeof billingOperations.$inferSelect;
export const acquireBillingOperation = (
  database: Database,
  input: {
    actor: OrganizationActor;
    operation: BillingOperation["operation"];
    requestKey: string;
    now: number;
  },
) =>
  database.db.transaction(
    (transaction) => {
      authorizeOrganization(
        transaction,
        input.actor,
        input.operation === "delete" ? "organization-delete" : "billing-write",
      );
      discardExpiredTransientOperations(transaction, input.actor.organizationId, input.now);
      const current = transaction
        .select()
        .from(billingOperations)
        .where(eq(billingOperations.organizationId, input.actor.organizationId))
        .get();
      if (
        current !== undefined &&
        (current.leaseExpiresAt > input.now ||
          current.operation !== input.operation ||
          current.requestKey !== input.requestKey)
      ) {
        throw billingBusy(
          "A billing operation is in progress or unresolved. Retry that same operation before starting another.",
        );
      }
      const lease = { leaseToken: randomUUID(), leaseExpiresAt: input.now + 60_000 };
      return transaction
        .insert(billingOperations)
        .values({
          organizationId: input.actor.organizationId,
          id: current?.id ?? randomUUID(),
          operation: input.operation,
          requestKey: input.requestKey,
          createdAt: current?.createdAt ?? input.now,
          ...lease,
        })
        .onConflictDoUpdate({ target: billingOperations.organizationId, set: lease })
        .returning()
        .get();
    },
    { behavior: "immediate" },
  );

export const requireBillingOperation = (
  transaction: DatabaseTransaction,
  operation: BillingOperation,
) => {
  const current = transaction
    .select()
    .from(billingOperations)
    .where(
      and(
        eq(billingOperations.organizationId, operation.organizationId),
        eq(billingOperations.leaseToken, operation.leaseToken),
      ),
    )
    .get();
  if (current === undefined)
    throw billingBusy(
      "This billing operation lease was superseded; retry to reconcile its result.",
    );
};

export const completeBillingOperation = (
  transaction: DatabaseTransaction,
  operation: BillingOperation,
) => {
  requireBillingOperation(transaction, operation);
  transaction
    .delete(billingOperations)
    .where(
      and(
        eq(billingOperations.organizationId, operation.organizationId),
        eq(billingOperations.leaseToken, operation.leaseToken),
      ),
    )
    .run();
};

// Releasing the local lease does not declare the provider operation unsuccessful.
// The durable operation identity remains, and only an identical retry can resume it.
export const yieldBillingOperation = (database: Database, operation: BillingOperation) =>
  database.db
    .update(billingOperations)
    .set({ leaseExpiresAt: 0 })
    .where(
      and(
        eq(billingOperations.organizationId, operation.organizationId),
        eq(billingOperations.leaseToken, operation.leaseToken),
      ),
    )
    .run();

// Portal sessions and deletion preflight do not create financial resources.
// They need serialization while running, not durable uncertainty after a crash.
export const discardExpiredTransientOperations = (
  transaction: DatabaseTransaction,
  organizationId: string,
  now: number,
) =>
  transaction
    .delete(billingOperations)
    .where(
      and(
        eq(billingOperations.organizationId, organizationId),
        inArray(billingOperations.operation, ["portal", "delete"]),
        lte(billingOperations.leaseExpiresAt, now),
      ),
    )
    .run();

export const releaseBillingOperation = (database: Database, operation: BillingOperation) =>
  database.db
    .delete(billingOperations)
    .where(
      and(
        eq(billingOperations.organizationId, operation.organizationId),
        eq(billingOperations.leaseToken, operation.leaseToken),
      ),
    )
    .run();

export const requireSafeProviderRetry = (createdAt: number, now: number) => {
  if (now - createdAt >= 23 * 60 * 60_000)
    throw billingBusy(
      "The provider result is unresolved beyond its idempotency retention window. Operator reconciliation is required; do not create a replacement attempt.",
    );
};
