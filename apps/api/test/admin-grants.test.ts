import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";

import { makeBillingService } from "../src/billing/billing-service.ts";
import { StripeGateway } from "../src/billing/stripe-gateway.ts";
import { type Database, migrateDatabase, openDatabase } from "../src/database/database.ts";
import {
  jobCreditEntries,
  jobs,
  stripeCustomers,
  stripeSubscriptions,
  users,
} from "../src/database/schema.ts";

const NOW = 1_800_000_000_000;
const PRICE_IDS = {
  basic: "price_basic",
  premium: "price_premium",
  pro: "price_pro",
} as const;
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

it("grants, lists, and revokes local Pro access idempotently", async () => {
  const database = await createTestDatabase();
  insertUser(database, "user-b", "b@example.com");
  insertUser(database, "user-a", "a@example.com");
  const service = makeBillingService(database, unusedStripeGateway);

  await expect(
    Effect.runPromise(service.grantPro({ grantedBy: "root", now: NOW, userId: "user-b" })),
  ).resolves.toMatchObject({ created: true });
  await expect(
    Effect.runPromise(
      service.grantPro({
        grantedBy: "different-admin",
        now: NOW + 1,
        userId: "user-b",
      }),
    ),
  ).resolves.toMatchObject({ created: false });
  await Effect.runPromise(service.grantPro({ grantedBy: "root", now: NOW + 2, userId: "user-a" }));

  await expect(Effect.runPromise(service.listProGrants())).resolves.toEqual([
    {
      email: "a@example.com",
      grantedAt: NOW + 2,
      grantedBy: "root",
      userId: "user-a",
    },
    {
      email: "b@example.com",
      grantedAt: NOW,
      grantedBy: "root",
      userId: "user-b",
    },
  ]);
  await expect(
    Effect.runPromise(service.revokePro({ now: NOW + 3, userId: "user-b" })),
  ).resolves.toEqual({ revoked: 1 });
  await expect(
    Effect.runPromise(service.revokePro({ now: NOW + 4, userId: "user-b" })),
  ).resolves.toEqual({ revoked: 0 });
});

it("reports whether Pro access comes from Stripe, admin, both, or neither", async () => {
  const database = await createTestDatabase();
  insertUser(database, "user-1", "agent@example.com");
  const service = makeBillingService(database, unusedStripeGateway);

  await expect(
    Effect.runPromise(service.getEntitlement({ now: NOW, priceIds: PRICE_IDS, userId: "user-1" })),
  ).resolves.toMatchObject({
    entitlements: { plan: "free" },
    source: "free",
  });
  await Effect.runPromise(service.grantPro({ grantedBy: "root", now: NOW, userId: "user-1" }));
  await expect(
    Effect.runPromise(service.getEntitlement({ now: NOW, priceIds: PRICE_IDS, userId: "user-1" })),
  ).resolves.toMatchObject({
    entitlements: { plan: "pro" },
    source: "admin",
  });

  insertActiveSubscription(database);
  await expect(
    Effect.runPromise(service.getEntitlement({ now: NOW, priceIds: PRICE_IDS, userId: "user-1" })),
  ).resolves.toMatchObject({ entitlements: { plan: "premium" }, source: "both" });
  await Effect.runPromise(service.revokePro({ now: NOW + 1, userId: "user-1" }));
  await expect(
    Effect.runPromise(service.getEntitlement({ now: NOW, priceIds: PRICE_IDS, userId: "user-1" })),
  ).resolves.toMatchObject({ entitlements: { plan: "premium" }, source: "stripe" });

  database.db
    .update(stripeSubscriptions)
    .set({ status: "past_due", updatedAt: NOW + 2 })
    .run();
  await expect(
    Effect.runPromise(service.getEntitlement({ now: NOW, priceIds: PRICE_IDS, userId: "user-1" })),
  ).resolves.toMatchObject({
    entitlements: { plan: "free" },
    source: "free",
  });
});

it("selects the highest active Stripe plan when several subscriptions exist", async () => {
  const database = await createTestDatabase();
  insertUser(database, "user-1", "agent@example.com");
  database.db
    .insert(stripeSubscriptions)
    .values([
      subscriptionValue("sub-premium", "price_premium", "active", NOW),
      subscriptionValue("sub-basic", "price_basic", "active", NOW + 1),
      subscriptionValue("sub-canceled", "price_pro", "canceled", NOW + 2),
    ])
    .run();
  const service = makeBillingService(database, unusedStripeGateway);

  await expect(
    Effect.runPromise(service.getEntitlement({ now: NOW, priceIds: PRICE_IDS, userId: "user-1" })),
  ).resolves.toMatchObject({
    entitlements: { plan: "premium" },
    source: "stripe",
    subscriptionStatus: "active",
  });
});

it("reports fractional usage and reservations from the current UTC credit ledger", async () => {
  const database = await createTestDatabase();
  insertUser(database, "user-1", "agent@example.com");
  database.db
    .insert(jobs)
    .values([
      jobValue("job-used", NOW - 2),
      jobValue("job-reserved", NOW - 1),
      jobValue("job-released", NOW),
    ])
    .run();
  database.db
    .insert(jobCreditEntries)
    .values([
      creditEntry("used-hold", "job-used", "hold", 5, NOW - 2),
      creditEntry("used-adjustment", "job-used", "adjustment", 120, NOW - 2),
      creditEntry("used-release", "job-used", "release", 125, NOW - 2),
      creditEntry("used-usage", "job-used", "usage", 125, NOW - 2),
      creditEntry("reserved-hold", "job-reserved", "hold", 5, NOW - 1),
      creditEntry("released-hold", "job-released", "hold", 5, NOW),
      creditEntry("released-release", "job-released", "release", 5, NOW),
    ])
    .run();
  const service = makeBillingService(database, unusedStripeGateway);

  await expect(
    Effect.runPromise(service.getEntitlement({ now: NOW, priceIds: PRICE_IDS, userId: "user-1" })),
  ).resolves.toMatchObject({
    credits: { available: 28.7, monthly: 30, reserved: 0.05, used: 1.25 },
    entitlements: { plan: "free" },
  });
});

const unusedStripeGateway = StripeGateway.of({
  createCheckoutSession: Effect.fn("UnusedStripe.createCheckoutSession")(() =>
    Effect.die("Stripe Checkout was not expected"),
  ),
  createPortalSession: Effect.fn("UnusedStripe.createPortalSession")(() =>
    Effect.die("Stripe Portal was not expected"),
  ),
  parseWebhook: Effect.fn("UnusedStripe.parseWebhook")(() =>
    Effect.die("Stripe webhook parsing was not expected"),
  ),
  retrieveSubscription: Effect.fn("UnusedStripe.retrieveSubscription")(() =>
    Effect.die("Stripe subscription retrieval was not expected"),
  ),
});

const createTestDatabase = async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffmpeg-api-admin-grant-"));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, "database.sqlite"));
  databases.push(database);
  migrateDatabase(database);
  return database;
};

const insertUser = (database: Database, id: string, email: string) => {
  database.db.insert(users).values({ createdAt: NOW, email, id, updatedAt: NOW }).run();
};

const insertActiveSubscription = (database: Database) => {
  database.db
    .insert(stripeCustomers)
    .values({ createdAt: NOW, customerId: "cus_agent", userId: "user-1" })
    .run();
  database.db
    .insert(stripeSubscriptions)
    .values({
      cancelAtPeriodEnd: false,
      customerId: "cus_agent",
      priceId: "price_premium",
      status: "active",
      subscriptionId: "sub_agent",
      updatedAt: NOW,
      userId: "user-1",
    })
    .run();
};

const subscriptionValue = (
  subscriptionId: string,
  priceId: string,
  status: string,
  updatedAt: number,
) => ({
  cancelAtPeriodEnd: false,
  customerId: "cus_agent",
  priceId,
  status,
  subscriptionId,
  updatedAt,
  userId: "user-1",
});

const jobValue = (id: string, now: number) => ({
  createdAt: now,
  declaredBytes: 5,
  id,
  kind: "compress" as const,
  maxUploadBytes: 1_000_000_000,
  optionsJson: "{}",
  plan: "free" as const,
  sourceFilename: "input.mp4",
  state: "queued" as const,
  updatedAt: now,
  userId: "user-1",
});

const creditEntry = (
  id: string,
  jobId: string,
  kind: typeof jobCreditEntries.$inferInsert.kind,
  units: number,
  createdAt: number,
) => ({
  createdAt,
  id,
  jobId,
  kind,
  periodStart: Date.UTC(new Date(NOW).getUTCFullYear(), new Date(NOW).getUTCMonth(), 1),
  units,
  userId: "user-1",
});
