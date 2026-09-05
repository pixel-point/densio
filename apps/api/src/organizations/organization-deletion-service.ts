import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import type { Database } from "../database/database.ts";
import { billingOperations, stripeCustomers } from "../database/schema.ts";
import {
  acceptOrganizationDeletion,
  deletionReceipt,
  organizationDeletionBlockers,
  requireNoDeletionBlockers,
} from "../database/organization-deletion-repository.ts";
import {
  acquireBillingOperation,
  discardExpiredTransientOperations,
} from "../billing/billing-operation-repository.ts";
import { reconcileSubscription } from "../billing/subscription-reconciliation.ts";
import { reconcileLiveCheckout } from "../billing/organization-checkout.ts";
import type { StripeGateway } from "../billing/stripe-gateway.ts";
import { authorizeOrganization, type OrganizationActor } from "./organization-access.ts";
import { organizationStorage } from "./organization-service.ts";
import { maintainOrganizationDeletions } from "./organization-cleanup.ts";
import { reapStoppedSourceWriters } from "../sources/source-write-activity.ts";

export const makeOrganizationDeletionService = (
  database: Database,
  gateway: StripeGateway["Service"],
  config: { mediaRoot: string; publicBaseUrl: string; now: () => number },
) => ({
  request: Effect.fn("Organization.requestDeletion")(function* (input: {
    actor: OrganizationActor;
    correlationId: string;
  }) {
    const context = yield* organizationStorage("authorize-organization-deletion", () =>
      authorizeOrganization(database.db, input.actor, "organization-delete", true),
    );
    if (context.organization.state !== "active")
      return deletionReceipt(context.organization, config.publicBaseUrl);
    yield* reapStoppedSourceWriters(database);
    yield* organizationStorage("check-deletion-preconditions", () =>
      database.db.transaction(
        (transaction) => {
          discardExpiredTransientOperations(transaction, input.actor.organizationId, config.now());
          requireNoDeletionBlockers(
            organizationDeletionBlockers(transaction, input.actor.organizationId).filter(
              ({ kind }) => kind !== "checkouts" && kind !== "subscriptions",
            ),
          );
        },
        { behavior: "immediate" },
      ),
    );
    const operation = yield* organizationStorage("acquire-deletion-fence", () =>
      acquireBillingOperation(database, {
        actor: input.actor,
        operation: "delete",
        requestKey: "close",
        now: config.now(),
      }),
    );
    return yield* Effect.gen(function* () {
      yield* reconcileLiveCheckout(database, gateway, operation, config.now());
      yield* reconcileOrganizationSubscriptions(
        database,
        gateway,
        input.actor.organizationId,
        config.now(),
      );
      const organization = yield* organizationStorage("accept-organization-deletion", () =>
        acceptOrganizationDeletion(database, { ...input, operation, now: config.now() }),
      );
      return deletionReceipt(organization, config.publicBaseUrl);
    }).pipe(
      Effect.ensuring(
        organizationStorage("release-deletion-fence", () =>
          database.db
            .delete(billingOperations)
            .where(
              and(
                eq(billingOperations.organizationId, operation.organizationId),
                eq(billingOperations.leaseToken, operation.leaseToken),
              ),
            )
            .run(),
        ).pipe(Effect.orDie),
      ),
    );
  }),
  maintain: ({ now }: { now: number }) =>
    maintainOrganizationDeletions(database, config.mediaRoot, now),
});
export type OrganizationDeletionService = ReturnType<typeof makeOrganizationDeletionService>;

const reconcileOrganizationSubscriptions = Effect.fn("Organization.reconcileBilling")(function* (
  database: Database,
  gateway: StripeGateway["Service"],
  organizationId: string,
  now: number,
) {
  const customer = yield* organizationStorage("find-closure-customer", () =>
    database.db
      .select()
      .from(stripeCustomers)
      .where(eq(stripeCustomers.organizationId, organizationId))
      .get(),
  );
  if (customer === undefined) return;
  const subscriptions = yield* gateway.listCustomerSubscriptions(customer.customerId);
  yield* Effect.forEach(subscriptions, (subscription) =>
    reconcileSubscription(database, gateway, {
      subscriptionId: subscription.subscriptionId,
      eventId: `closure:${randomUUID()}`,
      now,
    }),
  );
});
