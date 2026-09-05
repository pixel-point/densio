import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { ensureOrganizationActor } from "./organization-fixture-identity.ts";
import { seedJobInput } from "./job-fixture.ts";

import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";

import { makeBillingService } from "../src/billing/billing-service.ts";
import { unusedStripeGateway } from "./unused-stripe-gateway.ts";
import { type Database, migrateDatabase, openDatabase } from "../src/database/database.ts";
import {
  jobCreditEntries,
  jobs,
  stripeCustomers,
  stripeSubscriptions,
  users,
  organizations,
} from "../src/database/schema.ts";

const NOW = 1_800_000_000_000;
const PRICE_IDS = {
  basic: "price_basic",
  scale: "price_scale",
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
  insertOrganization(database, "org-b", "b@example.com");
  insertOrganization(database, "org-a", "a@example.com");
  const service = makeBillingService(database, unusedStripeGateway);

  await expect(
    Effect.runPromise(service.grantPro({ grantedBy: "root", now: NOW, organizationId: "org-b" })),
  ).resolves.toMatchObject({ created: true });
  await expect(
    Effect.runPromise(
      service.grantPro({
        grantedBy: "different-admin",
        now: NOW + 1,
        organizationId: "org-b",
      }),
    ),
  ).resolves.toMatchObject({ created: false });
  await Effect.runPromise(
    service.grantPro({ grantedBy: "root", now: NOW + 2, organizationId: "org-a" }),
  );

  await expect(Effect.runPromise(service.listProGrants())).resolves.toEqual([
    {
      billingEmail: "a@example.com",
      grantedAt: NOW + 2,
      grantedBy: "root",
      organizationId: "org-a",
    },
    {
      billingEmail: "b@example.com",
      grantedAt: NOW,
      grantedBy: "root",
      organizationId: "org-b",
    },
  ]);
  await expect(
    Effect.runPromise(
      service.revokePro({ revokedBy: "root", now: NOW + 3, organizationId: "org-b" }),
    ),
  ).resolves.toEqual({ revoked: 1 });
  await expect(
    Effect.runPromise(
      service.revokePro({ revokedBy: "root", now: NOW + 4, organizationId: "org-b" }),
    ),
  ).resolves.toEqual({ revoked: 0 });
});

it("reports whether Pro access comes from Stripe, admin, both, or neither", async () => {
  const database = await createTestDatabase();
  insertOrganization(database, "org-1", "agent@example.com");
  const service = makeBillingService(database, unusedStripeGateway);

  await expect(
    Effect.runPromise(
      service.getEntitlement({ now: NOW, priceIds: PRICE_IDS, organizationId: "org-1" }),
    ),
  ).resolves.toMatchObject({
    entitlements: { plan: "free" },
    source: "free",
  });
  await Effect.runPromise(
    service.grantPro({ grantedBy: "root", now: NOW, organizationId: "org-1" }),
  );
  await expect(
    Effect.runPromise(
      service.getEntitlement({ now: NOW, priceIds: PRICE_IDS, organizationId: "org-1" }),
    ),
  ).resolves.toMatchObject({
    entitlements: { plan: "pro" },
    source: "admin",
  });

  insertActiveSubscription(database);
  await expect(
    Effect.runPromise(
      service.getEntitlement({ now: NOW, priceIds: PRICE_IDS, organizationId: "org-1" }),
    ),
  ).resolves.toMatchObject({ entitlements: { plan: "scale" }, source: "both" });
  await Effect.runPromise(
    service.revokePro({ revokedBy: "root", now: NOW + 1, organizationId: "org-1" }),
  );
  await expect(
    Effect.runPromise(
      service.getEntitlement({ now: NOW, priceIds: PRICE_IDS, organizationId: "org-1" }),
    ),
  ).resolves.toMatchObject({ entitlements: { plan: "scale" }, source: "stripe" });

  database.db
    .update(stripeSubscriptions)
    .set({ status: "past_due", updatedAt: NOW + 2 })
    .run();
  await expect(
    Effect.runPromise(
      service.getEntitlement({ now: NOW, priceIds: PRICE_IDS, organizationId: "org-1" }),
    ),
  ).resolves.toMatchObject({
    entitlements: { plan: "free" },
    source: "free",
  });
});

it("selects the highest active Stripe plan when several subscriptions exist", async () => {
  const database = await createTestDatabase();
  insertOrganization(database, "org-1", "agent@example.com");
  database.db
    .insert(stripeSubscriptions)
    .values([
      subscriptionValue("sub-scale", "price_scale", "active", NOW),
      subscriptionValue("sub-basic", "price_basic", "active", NOW + 1),
      subscriptionValue("sub-canceled", "price_pro", "canceled", NOW + 2),
    ])
    .run();
  const service = makeBillingService(database, unusedStripeGateway);

  await expect(
    Effect.runPromise(
      service.getEntitlement({ now: NOW, priceIds: PRICE_IDS, organizationId: "org-1" }),
    ),
  ).resolves.toMatchObject({
    entitlements: { plan: "scale" },
    source: "stripe",
    subscriptionStatus: "active",
  });
});

it("reports fractional usage and reservations from the current UTC credit ledger", async () => {
  const database = await createTestDatabase();
  insertOrganization(database, "org-1", "agent@example.com");
  database.db
    .insert(jobs)
    .values([
      jobValue(database, "job-used", NOW - 2),
      jobValue(database, "job-reserved", NOW - 1),
      jobValue(database, "job-released", NOW),
    ])
    .run();
  database.db
    .insert(jobCreditEntries)
    .values([
      creditEntry("used-hold", "job-used", "hold", 125, NOW - 2),
      creditEntry("used-release", "job-used", "release", 125, NOW - 2),
      creditEntry("used-usage", "job-used", "usage", 125, NOW - 2),
      creditEntry("reserved-hold", "job-reserved", "hold", 5, NOW - 1),
      creditEntry("released-hold", "job-released", "hold", 5, NOW),
      creditEntry("released-release", "job-released", "release", 5, NOW),
    ])
    .run();
  const service = makeBillingService(database, unusedStripeGateway);

  await expect(
    Effect.runPromise(
      service.getEntitlement({ now: NOW, priceIds: PRICE_IDS, organizationId: "org-1" }),
    ),
  ).resolves.toMatchObject({
    credits: { available: 28.7, monthly: 30, reserved: 0.05, used: 1.25 },
    entitlements: { plan: "free" },
  });
});

const createTestDatabase = async () => {
  const directory = await mkdtemp(join(tmpdir(), "densio-admin-grant-"));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, "database.sqlite"));
  databases.push(database);
  migrateDatabase(database);
  return database;
};

const insertOrganization = (database: Database, id: string, email: string) => {
  database.db
    .insert(users)
    .values({ createdAt: NOW, email, id: `owner-${id}`, updatedAt: NOW })
    .run();
  ensureOrganizationActor(database, id, `owner-${id}`);
  database.db
    .update(organizations)
    .set({ billingEmail: email })
    .where(eq(organizations.id, id))
    .run();
};

const insertActiveSubscription = (database: Database) => {
  database.db
    .insert(stripeCustomers)
    .values({ createdAt: NOW, customerId: "cus_agent", organizationId: "org-1" })
    .run();
  database.db
    .insert(stripeSubscriptions)
    .values({
      cancelAtPeriodEnd: false,
      customerId: "cus_agent",
      priceId: "price_scale",
      status: "active",
      subscriptionId: "sub_agent",
      updatedAt: NOW,
      organizationId: "org-1",
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
  organizationId: "org-1",
});

const jobValue = (database: Database, id: string, now: number) =>
  seedJobInput(database, {
    createdByUserId: "owner-org-1",
    createdAt: now,
    id,
    state: "queued",
    updatedAt: now,
    organizationId: "org-1",
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
  organizationId: "org-1",
});
