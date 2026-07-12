import { Context, Effect } from "effect";
import type Stripe from "stripe";

import type { Database } from "../database/database.ts";
import {
  BillingCustomerNotFound,
  BillingStorageError,
  BillingUserNotFound,
  BillingWebhookUnmatched,
  type InvalidStripeWebhook,
  type StripeGatewayError,
} from "./billing-errors.ts";
import {
  type EffectiveBillingEntitlement,
  findBillingAccount,
  findEffectiveBillingEntitlement,
  grantAdminPro,
  listAdminProGrants,
  processBillingWebhook,
  type ProGrant,
  revokeAdminPro,
} from "./billing-repository.ts";
import { type HostedStripeSession, type StripeGateway } from "./stripe-gateway.ts";

export interface BillingConfig {
  readonly checkoutCancelUrl: string;
  readonly checkoutSuccessUrl: string;
  readonly portalReturnUrl: string;
  readonly proPriceId: string;
  readonly webhookSecret: string;
}

export interface BillingServiceDefinition {
  readonly createCheckout: (input: {
    readonly config: BillingConfig;
    readonly userId: string;
  }) => Effect.Effect<
    HostedStripeSession,
    BillingStorageError | BillingUserNotFound | StripeGatewayError
  >;
  readonly createPortal: (input: {
    readonly config: BillingConfig;
    readonly userId: string;
  }) => Effect.Effect<
    HostedStripeSession,
    BillingCustomerNotFound | BillingStorageError | BillingUserNotFound | StripeGatewayError
  >;
  readonly getEntitlement: (input: {
    readonly proPriceId: string;
    readonly userId: string;
  }) => Effect.Effect<EffectiveBillingEntitlement, BillingStorageError | BillingUserNotFound>;
  readonly grantPro: (input: {
    readonly grantedBy: string;
    readonly now: number;
    readonly userId: string;
  }) => Effect.Effect<{ readonly created: boolean }, BillingStorageError | BillingUserNotFound>;
  readonly handleWebhook: (input: {
    readonly config: BillingConfig;
    readonly now: number;
    readonly rawBody: string | Uint8Array;
    readonly signature: string;
  }) => Effect.Effect<
    { readonly processed: boolean },
    BillingStorageError | BillingWebhookUnmatched | InvalidStripeWebhook
  >;
  readonly listProGrants: () => Effect.Effect<ReadonlyArray<ProGrant>, BillingStorageError>;
  readonly revokePro: (input: {
    readonly now: number;
    readonly userId: string;
  }) => Effect.Effect<{ readonly revoked: number }, BillingStorageError | BillingUserNotFound>;
}

export class BillingService extends Context.Service<BillingService, BillingServiceDefinition>()(
  "ffmpeg-api/billing/BillingService",
) {}

type StripeGatewayService = StripeGateway["Service"];

export const makeBillingService = (database: Database, stripeGateway: StripeGatewayService) => {
  const createCheckout = Effect.fn("BillingService.createCheckout")(function* (input: {
    readonly config: BillingConfig;
    readonly userId: string;
  }) {
    const account = yield* findAccount(database, input.userId);
    return yield* stripeGateway.createCheckoutSession(buildCheckoutParams(account, input.config));
  });

  const createPortal = Effect.fn("BillingService.createPortal")(function* (input: {
    readonly config: BillingConfig;
    readonly userId: string;
  }) {
    const account = yield* findAccount(database, input.userId);
    if (account.customerId === null) {
      return yield* new BillingCustomerNotFound({ userId: input.userId });
    }
    return yield* stripeGateway.createPortalSession({
      customer: account.customerId,
      return_url: input.config.portalReturnUrl,
    });
  });

  const handleWebhook = Effect.fn("BillingService.handleWebhook")(function* (input: {
    readonly config: BillingConfig;
    readonly now: number;
    readonly rawBody: string | Uint8Array;
    readonly signature: string;
  }) {
    const event = yield* stripeGateway.parseWebhook({
      rawBody: input.rawBody,
      signature: input.signature,
      webhookSecret: input.config.webhookSecret,
    });
    const outcome = yield* tryStorage("process-webhook", () =>
      processBillingWebhook(database, event, input.now),
    );
    if (outcome.kind === "unmatched") {
      return yield* new BillingWebhookUnmatched({ eventId: event.eventId });
    }
    return { processed: outcome.kind === "processed" };
  });

  const grantPro = Effect.fn("BillingService.grantPro")(function* (input: {
    readonly grantedBy: string;
    readonly now: number;
    readonly userId: string;
  }) {
    const outcome = yield* tryStorage("grant-pro", () => grantAdminPro(database, input));
    if (outcome.kind === "user-missing") {
      return yield* new BillingUserNotFound({ userId: input.userId });
    }
    return { created: outcome.created };
  });

  const revokePro = Effect.fn("BillingService.revokePro")(function* (input: {
    readonly now: number;
    readonly userId: string;
  }) {
    yield* findAccount(database, input.userId);
    const revoked = yield* tryStorage("revoke-pro", () => revokeAdminPro(database, input));
    return { revoked };
  });

  const listProGrants = Effect.fn("BillingService.listProGrants")(function* () {
    return yield* tryStorage("list-pro-grants", () => listAdminProGrants(database));
  });

  const getEntitlement = Effect.fn("BillingService.getEntitlement")(function* (input: {
    readonly proPriceId: string;
    readonly userId: string;
  }) {
    const entitlement = yield* tryStorage("get-entitlement", () =>
      findEffectiveBillingEntitlement(database, input),
    );
    if (entitlement === undefined) {
      return yield* new BillingUserNotFound({ userId: input.userId });
    }
    return entitlement;
  });

  return BillingService.of({
    createCheckout,
    createPortal,
    getEntitlement,
    grantPro,
    handleWebhook,
    listProGrants,
    revokePro,
  });
};

const findAccount = Effect.fn("BillingService.findAccount")(function* (
  database: Database,
  userId: string,
) {
  const account = yield* tryStorage("find-account", () => findBillingAccount(database, userId));
  if (account === undefined) return yield* new BillingUserNotFound({ userId });
  return account;
});

const tryStorage = Effect.fn("BillingService.tryStorage")(
  <Value>(operation: string, evaluate: () => Value) =>
    Effect.try({
      catch: (cause) => new BillingStorageError({ cause, operation }),
      try: evaluate,
    }),
);

const buildCheckoutParams = (
  account: { readonly customerId: string | null; readonly email: string; readonly userId: string },
  config: BillingConfig,
): Stripe.Checkout.SessionCreateParams => ({
  cancel_url: config.checkoutCancelUrl,
  client_reference_id: account.userId,
  ...(account.customerId === null
    ? { customer_email: account.email }
    : { customer: account.customerId }),
  line_items: [{ price: config.proPriceId, quantity: 1 }],
  metadata: { userId: account.userId },
  mode: "subscription",
  subscription_data: { metadata: { userId: account.userId } },
  success_url: config.checkoutSuccessUrl,
});
