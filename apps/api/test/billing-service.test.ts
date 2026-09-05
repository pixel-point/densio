import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import type Stripe from "stripe";
import { afterEach, expect, it } from "vitest";

import { BillingCustomerNotFound } from "../src/billing/billing-errors.ts";
import { type BillingConfig, makeBillingService } from "../src/billing/billing-service.ts";
import { type BillingWebhookEvent, StripeGateway } from "../src/billing/stripe-gateway.ts";
import { type Database, migrateDatabase, openDatabase } from "../src/database/database.ts";
import { stripeCustomers, stripeEvents, stripeSubscriptions } from "../src/database/schema.ts";

import {
  ensureOrganizationActor,
  fixtureOrganizationActor,
  otherFixtureOrganizationActor,
} from "./organization-fixture-identity.ts";
import { unusedStripeGateway } from "./unused-stripe-gateway.ts";

const NOW = 1_800_000_000_000;
const BILLING_CONFIG: BillingConfig = {
  checkoutCancelUrl: "https://app.example/billing/canceled",
  checkoutSuccessUrl: "https://app.example/billing/success",
  portalReturnUrl: "https://app.example/settings/billing",
  priceIds: {
    basic: "price_basic",
    scale: "price_scale",
    pro: "price_pro",
  },
  webhookSecret: "whsec_fixture",
};

const databases: Array<Database> = [];
const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

it("builds subscription Checkout params for new and known Stripe customers", async () => {
  const database = await createTestDatabase();
  ensureOrganizationActor(database);
  const fixture = makeRecordingGateway({ kind: "ignored", eventId: "evt_ignored" });
  const service = makeBillingService(database, fixture.gateway, () => NOW);

  await expect(
    Effect.runPromise(
      service.createCheckout({
        config: BILLING_CONFIG,
        plan: "basic",
        actor: fixtureOrganizationActor,
        idempotencyKey: "checkout-basic",
        correlationId: "test",
      }),
    ),
  ).resolves.toEqual({
    organizationId: "org-1",
    kind: "checkout",
    expiresAt: new Date(NOW + 1_800_000).toISOString(),
    url: "https://checkout.stripe.test/session",
  });
  expect(fixture.checkoutRequests[0]).toEqual({
    cancel_url: BILLING_CONFIG.checkoutCancelUrl,
    client_reference_id: "org-1",
    customer: "cus_org-1",
    line_items: [{ price: "price_basic", quantity: 1 }],
    metadata: { organizationId: "org-1", attemptId: expect.any(String) },
    mode: "subscription",
    subscription_data: { metadata: { organizationId: "org-1" } },
    success_url: BILLING_CONFIG.checkoutSuccessUrl,
  });

  ensureOrganizationActor(database, "org-2", "user-2");
  database.db
    .insert(stripeCustomers)
    .values({ createdAt: NOW, customerId: "cus_existing", organizationId: "org-2" })
    .run();
  await Effect.runPromise(
    service.createCheckout({
      config: BILLING_CONFIG,
      plan: "scale",
      actor: otherFixtureOrganizationActor,
      idempotencyKey: "checkout-scale",
      correlationId: "test",
    }),
  );

  expect(fixture.checkoutRequests[1]).toEqual({
    cancel_url: BILLING_CONFIG.checkoutCancelUrl,
    client_reference_id: "org-2",
    customer: "cus_existing",
    line_items: [{ price: "price_scale", quantity: 1 }],
    metadata: { organizationId: "org-2", attemptId: expect.any(String) },
    mode: "subscription",
    subscription_data: { metadata: { organizationId: "org-2" } },
    success_url: BILLING_CONFIG.checkoutSuccessUrl,
  });
});

it("creates Customer Portal params and rejects users without a Stripe customer", async () => {
  const database = await createTestDatabase();
  ensureOrganizationActor(database);
  ensureOrganizationActor(database, "org-2", "user-2");
  database.db
    .insert(stripeCustomers)
    .values({ createdAt: NOW, customerId: "cus_existing", organizationId: "org-1" })
    .run();
  const fixture = makeRecordingGateway({ kind: "ignored", eventId: "evt_ignored" });
  const service = makeBillingService(database, fixture.gateway, () => NOW);

  await expect(
    Effect.runPromise(
      service.createPortal({
        config: BILLING_CONFIG,
        actor: fixtureOrganizationActor,
        correlationId: "test",
      }),
    ),
  ).resolves.toEqual({
    organizationId: "org-1",
    kind: "portal",
    url: "https://billing.stripe.test/session",
  });
  expect(fixture.portalRequests).toEqual([
    {
      customer: "cus_existing",
      return_url: BILLING_CONFIG.portalReturnUrl,
    },
  ]);

  const missing = await Effect.runPromise(
    Effect.flip(
      service.createPortal({
        config: BILLING_CONFIG,
        actor: otherFixtureOrganizationActor,
        correlationId: "test",
      }),
    ),
  );
  expect(missing).toBeInstanceOf(BillingCustomerNotFound);
});

it("processes subscription webhooks idempotently and supports update and delete", async () => {
  const database = await createTestDatabase();
  ensureOrganizationActor(database);
  database.db
    .insert(stripeCustomers)
    .values({ createdAt: NOW, customerId: "cus_agent", organizationId: "org-1" })
    .run();
  const createdEvent = subscriptionSignal("evt_created");
  const createdService = makeBillingService(
    database,
    makeRecordingGateway(createdEvent, subscriptionState("active")).gateway,
  );

  await expect(Effect.runPromise(handleWebhook(createdService, NOW))).resolves.toEqual({
    processed: true,
  });
  await expect(Effect.runPromise(handleWebhook(createdService, NOW + 1))).resolves.toEqual({
    processed: false,
  });
  expect(database.db.select().from(stripeEvents).all()).toHaveLength(1);
  expect(database.db.select().from(stripeCustomers).get()).toMatchObject({
    customerId: "cus_agent",
    organizationId: "org-1",
  });
  expect(database.db.select().from(stripeSubscriptions).get()).toMatchObject({
    currentPeriodEnd: 1_900_000_000_000,
    priceId: "price_scale",
    status: "active",
  });

  const updatedService = makeBillingService(
    database,
    makeRecordingGateway(subscriptionSignal("evt_updated"), subscriptionState("past_due")).gateway,
  );
  await Effect.runPromise(handleWebhook(updatedService, NOW + 2));
  expect(database.db.select().from(stripeSubscriptions).get()?.status).toBe("past_due");

  const deletedService = makeBillingService(
    database,
    makeRecordingGateway(subscriptionSignal("evt_deleted"), subscriptionState("canceled")).gateway,
  );
  await Effect.runPromise(handleWebhook(deletedService, NOW + 3));
  expect(database.db.select().from(stripeSubscriptions).get()?.status).toBe("canceled");
});

it("synchronizes current Stripe state when subscription webhooks arrive out of order", async () => {
  const database = await createTestDatabase();
  ensureOrganizationActor(database);
  database.db
    .insert(stripeCustomers)
    .values({ createdAt: NOW, customerId: "cus_agent", organizationId: "org-1" })
    .run();
  const current = subscriptionState("canceled");
  const deleted = makeRecordingGateway(subscriptionSignal("evt_deleted"), current);
  const delayed = makeRecordingGateway(subscriptionSignal("evt_delayed"), current);

  await Effect.runPromise(handleWebhook(makeBillingService(database, deleted.gateway), NOW));
  await Effect.runPromise(handleWebhook(makeBillingService(database, delayed.gateway), NOW + 1));

  expect(deleted.retrievedSubscriptionIds).toEqual(["sub_agent"]);
  expect(delayed.retrievedSubscriptionIds).toEqual(["sub_agent"]);
  expect(database.db.select().from(stripeSubscriptions).get()?.status).toBe("canceled");
});

const createTestDatabase = async () => {
  const directory = await mkdtemp(join(tmpdir(), "densio-billing-"));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, "database.sqlite"));
  databases.push(database);
  migrateDatabase(database);
  return database;
};

it("does not let an older overlapping Stripe retrieval overwrite a newer reconciliation", async () => {
  const database = await createTestDatabase();
  ensureOrganizationActor(database);
  database.db
    .insert(stripeCustomers)
    .values({
      organizationId: "org-1",
      customerId: "cus_agent",
      createdAt: NOW,
    })
    .run();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const reads: string[] = [];
  const gateway = StripeGateway.of({
    ...unusedStripeGateway,
    parseWebhook: ({ rawBody }) => Effect.succeed(subscriptionSignal(String(rawBody))),
    retrieveSubscription: () =>
      Effect.promise(async () => {
        reads.push("read");
        if (reads.length === 1) {
          started.resolve();
          await release.promise;
          return subscriptionState("active");
        }
        return subscriptionState("canceled");
      }),
  });
  const service = makeBillingService(database, gateway);
  const first = Effect.runPromise(
    Effect.result(
      service.handleWebhook({
        config: BILLING_CONFIG,
        now: NOW,
        rawBody: "old",
        signature: "test",
      }),
    ),
  );
  await started.promise;
  await Effect.runPromise(
    service.handleWebhook({
      config: BILLING_CONFIG,
      now: NOW + 1,
      rawBody: "new",
      signature: "test",
    }),
  );
  release.resolve();
  const stale = await first;
  expect(stale).toMatchObject({ failure: { _tag: "BillingWebhookUnmatched" } });
  expect(database.db.select().from(stripeSubscriptions).get()?.status).toBe("canceled");
  expect(database.db.select().from(stripeEvents).all()).toHaveLength(1);
});

const makeRecordingGateway = (
  event: BillingWebhookEvent,
  currentSubscription = subscriptionState("active"),
) => {
  const checkoutRequests: Array<Stripe.Checkout.SessionCreateParams> = [];
  const portalRequests: Array<Stripe.BillingPortal.SessionCreateParams> = [];
  const retrievedSubscriptionIds: Array<string> = [];
  const gateway = StripeGateway.of({
    ...unusedStripeGateway,
    createCustomer: (params) =>
      Effect.succeed(`cus_${params.metadata && params.metadata.organizationId}`),
    findCustomer: () => Effect.succeed(null),
    findCheckoutSession: () => Effect.succeed(null),
    createCheckoutSession: Effect.fn("TestStripe.createCheckoutSession")((params) =>
      Effect.sync(() => {
        checkoutRequests.push(params);
        return {
          id: `cs_${params.client_reference_id}`,
          status: "open" as const,
          expiresAt: NOW + 1_800_000,
          customerId: String(params.customer),
          subscriptionId: null,
          organizationId: params.client_reference_id ?? "",
          attemptId: String(params.metadata?.attemptId ?? ""),
          url: "https://checkout.stripe.test/session",
        };
      }),
    ),
    createPortalSession: Effect.fn("TestStripe.createPortalSession")((params) =>
      Effect.sync(() => {
        portalRequests.push(params);
        return {
          id: "bps_fixture",
          url: "https://billing.stripe.test/session",
        };
      }),
    ),
    parseWebhook: Effect.fn("TestStripe.parseWebhook")(() => Effect.succeed(event)),
    retrieveSubscription: Effect.fn("TestStripe.retrieveSubscription")((subscriptionId: string) =>
      Effect.sync(() => {
        retrievedSubscriptionIds.push(subscriptionId);
        return currentSubscription;
      }),
    ),
  });
  return { checkoutRequests, gateway, portalRequests, retrievedSubscriptionIds };
};

const subscriptionSignal = (eventId: string): BillingWebhookEvent => ({
  eventId,
  kind: "subscription-sync",
  subscriptionId: "sub_agent",
});

const subscriptionState = (status: "active" | "canceled" | "past_due") => ({
  cancelAtPeriodEnd: false,
  currentPeriodEnd: 1_900_000_000_000,
  customerId: "cus_agent",
  priceId: "price_scale",
  status,
  subscriptionId: "sub_agent",
  organizationId: "org-1",
});

const handleWebhook = (service: ReturnType<typeof makeBillingService>, now: number) =>
  service.handleWebhook({
    config: BILLING_CONFIG,
    now,
    rawBody: Buffer.from("fixture"),
    signature: "fixture-signature",
  });
