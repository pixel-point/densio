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
import {
  stripeCustomers,
  stripeEvents,
  stripeSubscriptions,
  users,
} from "../src/database/schema.ts";

const NOW = 1_800_000_000_000;
const BILLING_CONFIG: BillingConfig = {
  checkoutCancelUrl: "https://app.example/billing/canceled",
  checkoutSuccessUrl: "https://app.example/billing/success",
  portalReturnUrl: "https://app.example/settings/billing",
  proPriceId: "price_pro",
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
  insertUser(database, "user-1", "agent@example.com");
  const fixture = makeRecordingGateway({ kind: "ignored", eventId: "evt_ignored" });
  const service = makeBillingService(database, fixture.gateway);

  await expect(
    Effect.runPromise(service.createCheckout({ config: BILLING_CONFIG, userId: "user-1" })),
  ).resolves.toEqual({
    id: "cs_fixture",
    url: "https://checkout.stripe.test/session",
  });
  expect(fixture.checkoutRequests[0]).toEqual({
    cancel_url: BILLING_CONFIG.checkoutCancelUrl,
    client_reference_id: "user-1",
    customer_email: "agent@example.com",
    line_items: [{ price: "price_pro", quantity: 1 }],
    metadata: { userId: "user-1" },
    mode: "subscription",
    subscription_data: { metadata: { userId: "user-1" } },
    success_url: BILLING_CONFIG.checkoutSuccessUrl,
  });

  database.db
    .insert(stripeCustomers)
    .values({ createdAt: NOW, customerId: "cus_existing", userId: "user-1" })
    .run();
  await Effect.runPromise(service.createCheckout({ config: BILLING_CONFIG, userId: "user-1" }));

  expect(fixture.checkoutRequests[1]).toEqual({
    cancel_url: BILLING_CONFIG.checkoutCancelUrl,
    client_reference_id: "user-1",
    customer: "cus_existing",
    line_items: [{ price: "price_pro", quantity: 1 }],
    metadata: { userId: "user-1" },
    mode: "subscription",
    subscription_data: { metadata: { userId: "user-1" } },
    success_url: BILLING_CONFIG.checkoutSuccessUrl,
  });
});

it("creates Customer Portal params and rejects users without a Stripe customer", async () => {
  const database = await createTestDatabase();
  insertUser(database, "user-1", "agent@example.com");
  insertUser(database, "user-2", "other@example.com");
  database.db
    .insert(stripeCustomers)
    .values({ createdAt: NOW, customerId: "cus_existing", userId: "user-1" })
    .run();
  const fixture = makeRecordingGateway({ kind: "ignored", eventId: "evt_ignored" });
  const service = makeBillingService(database, fixture.gateway);

  await expect(
    Effect.runPromise(service.createPortal({ config: BILLING_CONFIG, userId: "user-1" })),
  ).resolves.toEqual({
    id: "bps_fixture",
    url: "https://billing.stripe.test/session",
  });
  expect(fixture.portalRequests).toEqual([
    {
      customer: "cus_existing",
      return_url: BILLING_CONFIG.portalReturnUrl,
    },
  ]);

  const missing = await Effect.runPromise(
    Effect.flip(service.createPortal({ config: BILLING_CONFIG, userId: "user-2" })),
  );
  expect(missing).toBeInstanceOf(BillingCustomerNotFound);
});

it("processes subscription webhooks idempotently and supports update and delete", async () => {
  const database = await createTestDatabase();
  insertUser(database, "user-1", "agent@example.com");
  const createdEvent = subscriptionUpsertEvent({
    eventId: "evt_created",
    status: "active",
  });
  const createdService = makeBillingService(database, makeRecordingGateway(createdEvent).gateway);

  await expect(Effect.runPromise(handleWebhook(createdService, NOW))).resolves.toEqual({
    processed: true,
  });
  await expect(Effect.runPromise(handleWebhook(createdService, NOW + 1))).resolves.toEqual({
    processed: false,
  });
  expect(database.db.select().from(stripeEvents).all()).toHaveLength(1);
  expect(database.db.select().from(stripeCustomers).get()).toMatchObject({
    customerId: "cus_agent",
    userId: "user-1",
  });
  expect(database.db.select().from(stripeSubscriptions).get()).toMatchObject({
    currentPeriodEnd: 1_900_000_000_000,
    priceId: "price_pro",
    status: "active",
  });

  const updatedService = makeBillingService(
    database,
    makeRecordingGateway(subscriptionUpsertEvent({ eventId: "evt_updated", status: "past_due" }))
      .gateway,
  );
  await Effect.runPromise(handleWebhook(updatedService, NOW + 2));
  expect(database.db.select().from(stripeSubscriptions).get()?.status).toBe("past_due");

  const deletedService = makeBillingService(
    database,
    makeRecordingGateway({
      eventId: "evt_deleted",
      kind: "subscription-delete",
      subscriptionId: "sub_agent",
    }).gateway,
  );
  await Effect.runPromise(handleWebhook(deletedService, NOW + 3));
  expect(database.db.select().from(stripeSubscriptions).all()).toHaveLength(0);
});

const createTestDatabase = async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffmpeg-api-billing-"));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, "database.sqlite"));
  databases.push(database);
  migrateDatabase(database);
  return database;
};

const insertUser = (database: Database, id: string, email: string) => {
  database.db.insert(users).values({ createdAt: NOW, email, id, updatedAt: NOW }).run();
};

const makeRecordingGateway = (event: BillingWebhookEvent) => {
  const checkoutRequests: Array<Stripe.Checkout.SessionCreateParams> = [];
  const portalRequests: Array<Stripe.BillingPortal.SessionCreateParams> = [];
  const gateway = StripeGateway.of({
    createCheckoutSession: Effect.fn("TestStripe.createCheckoutSession")((params) =>
      Effect.sync(() => {
        checkoutRequests.push(params);
        return {
          id: "cs_fixture",
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
  });
  return { checkoutRequests, gateway, portalRequests };
};

const subscriptionUpsertEvent = ({
  eventId,
  status,
}: {
  readonly eventId: string;
  readonly status: "active" | "past_due";
}): BillingWebhookEvent => ({
  cancelAtPeriodEnd: false,
  currentPeriodEnd: 1_900_000_000_000,
  customerId: "cus_agent",
  eventId,
  kind: "subscription-upsert",
  priceId: "price_pro",
  status,
  subscriptionId: "sub_agent",
  userId: "user-1",
});

const handleWebhook = (service: ReturnType<typeof makeBillingService>, now: number) =>
  service.handleWebhook({
    config: BILLING_CONFIG,
    now,
    rawBody: Buffer.from("fixture"),
    signature: "fixture-signature",
  });
