import { Context, Effect } from "effect";
import type { Database } from "../database/database.ts";
import { organizationFailure } from "../organizations/organization-errors.ts";
import { organizationStorage } from "../organizations/organization-service.ts";
import { BillingWebhookUnmatched } from "./billing-errors.ts";
import {
  type BillingPriceIds,
  findEffectiveBillingEntitlement,
  grantAdminPro,
  listAdminProGrants,
  processBillingWebhook,
  revokeAdminPro,
} from "./billing-repository.ts";
import type { StripeGateway } from "./stripe-gateway.ts";
import { makeOrganizationCheckout } from "./organization-checkout.ts";
import { makeOrganizationBillingControl } from "./organization-billing-control.ts";
import { reconcileSubscription } from "./subscription-reconciliation.ts";

export interface BillingConfig {
  readonly checkoutCancelUrl: string;
  readonly checkoutSuccessUrl: string;
  readonly portalReturnUrl: string;
  readonly priceIds: BillingPriceIds;
  readonly webhookSecret: string;
}

const createBillingService = (
  database: Database,
  gateway: StripeGateway["Service"],
  now: () => number,
) => ({
  ...makeOrganizationBillingControl(database, gateway, now),
  createCheckout: makeOrganizationCheckout(database, gateway, now),
  getEntitlement: (input: Parameters<typeof findEffectiveBillingEntitlement>[1]) =>
    organizationStorage("get-entitlement", () => {
      const entitlement = findEffectiveBillingEntitlement(database, input);
      if (entitlement === undefined)
        throw organizationFailure("ORGANIZATION_NOT_FOUND", "Organization not found.");
      return entitlement;
    }),
  grantPro: (input: Parameters<typeof grantAdminPro>[1]) =>
    organizationStorage("grant-pro", () => {
      const outcome = grantAdminPro(database, input);
      if (outcome.kind === "organization-missing")
        throw organizationFailure("ORGANIZATION_NOT_FOUND", "Organization not found.");
      return { created: outcome.created };
    }),
  revokePro: (input: Parameters<typeof revokeAdminPro>[1]) =>
    organizationStorage("revoke-pro", () => ({ revoked: revokeAdminPro(database, input) })),
  listProGrants: () => organizationStorage("list-pro-grants", () => listAdminProGrants(database)),
  handleWebhook: makeWebhookHandler(database, gateway),
});

export type BillingServiceDefinition = ReturnType<typeof createBillingService>;
export class BillingService extends Context.Service<BillingService, BillingServiceDefinition>()(
  "densio/billing/BillingService",
) {}
export const makeBillingService = (
  database: Database,
  gateway: StripeGateway["Service"],
  now: () => number = Date.now,
) => BillingService.of(createBillingService(database, gateway, now));

const makeWebhookHandler = (database: Database, gateway: StripeGateway["Service"]) =>
  Effect.fn("Billing.handleWebhook")(function* (input: {
    readonly config: BillingConfig;
    readonly now: number;
    readonly rawBody: string | Uint8Array;
    readonly signature: string;
  }) {
    const event = yield* gateway.parseWebhook({
      rawBody: input.rawBody,
      signature: input.signature,
      webhookSecret: input.config.webhookSecret,
    });
    if (event.kind === "subscription-sync") {
      const outcome = yield* reconcileSubscription(database, gateway, { ...event, now: input.now });
      return { processed: outcome.kind === "processed" };
    }
    const outcome = yield* organizationStorage("process-webhook", () =>
      processBillingWebhook(database, event, input.now),
    );
    if (outcome.kind === "unmatched")
      return yield* new BillingWebhookUnmatched({ eventId: event.eventId });
    return { processed: outcome.kind === "processed" };
  });
