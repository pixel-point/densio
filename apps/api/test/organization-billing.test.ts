import { afterEach, expect, it } from "vitest";
import { organizationFixture, organizationNow } from "./organization-test-support.ts";
import {
  findBillingAccount,
  findEffectiveBillingEntitlement,
  grantAdminPro,
  processBillingWebhook,
} from "../src/billing/billing-repository.ts";
import {
  organizationAuditEvents,
  organizations,
  stripeCustomers,
  stripeSubscriptions,
} from "../src/database/schema.ts";
import { eq } from "drizzle-orm";
import { normalizeStripeSubscription } from "../src/billing/stripe-gateway.ts";

const fixtures: ReturnType<typeof organizationFixture>[] = [];
const setup = () => {
  const fixture = organizationFixture();
  fixtures.push(fixture);
  return fixture;
};
afterEach(() => fixtures.splice(0).forEach(({ database }) => database.close()));
const priceIds = { basic: "price_basic", pro: "price_pro", scale: "price_scale" };

it("normalizes organization metadata from authoritative subscription state", () => {
  expect(
    normalizeStripeSubscription({
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      cancel_at_period_end: false,
      metadata: { organizationId: "org-1" },
      items: {
        data: [{ current_period_end: 1_800_000_000, price: { id: "price_basic" }, quantity: 1 }],
      },
    }),
  ).toMatchObject({ organizationId: "org-1" });
});

it("uses the organization's contact and one allowance regardless of member count", () => {
  const fixture = setup();
  expect(findBillingAccount(fixture.database, fixture.organizationId)).toMatchObject({
    organizationId: fixture.organizationId,
    billingEmail: "owner@example.test",
    customerId: null,
  });
  expect(
    findEffectiveBillingEntitlement(fixture.database, {
      organizationId: fixture.organizationId,
      now: organizationNow,
      priceIds,
    }),
  ).toMatchObject({
    organizationId: fixture.organizationId,
    credits: { available: 30, monthly: 30, reserved: 0, used: 0 },
  });
  grantAdminPro(fixture.database, {
    organizationId: fixture.organizationId,
    now: organizationNow,
    grantedBy: "local-test-operator",
  });
  expect(
    findEffectiveBillingEntitlement(fixture.database, {
      organizationId: fixture.organizationId,
      now: organizationNow,
      priceIds,
    })?.credits.monthly,
  ).toBe(5_000);
  expect(
    findEffectiveBillingEntitlement(fixture.database, {
      organizationId: fixture.outside.organization.id,
      now: organizationNow,
      priceIds,
    })?.credits.monthly,
  ).toBe(30);
});

it("rejects customer/metadata mismatches instead of assigning subscriptions by actor", () => {
  const fixture = setup();
  expect(findBillingAccount(fixture.database, fixture.organizationId)).toBeDefined();
  fixture.database.db
    .insert(stripeCustomers)
    .values({
      organizationId: fixture.organizationId,
      customerId: "cus_team",
      createdAt: organizationNow,
    })
    .run();
  const event = {
    eventId: "evt_1",
    kind: "subscription-upsert" as const,
    customerId: "cus_team",
    organizationId: fixture.outside.organization.id,
    subscriptionId: "sub_team",
    priceId: "price_basic",
    status: "active" as const,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: organizationNow + 86_400_000,
  };
  expect(processBillingWebhook(fixture.database, event, organizationNow)).toEqual({
    kind: "unmatched",
  });
  expect(fixture.database.db.select().from(stripeSubscriptions).all()).toHaveLength(0);
  expect(
    processBillingWebhook(
      fixture.database,
      { ...event, organizationId: fixture.organizationId },
      organizationNow,
    ),
  ).toEqual({ kind: "processed" });
  expect(
    processBillingWebhook(
      fixture.database,
      { ...event, organizationId: fixture.organizationId },
      organizationNow,
    ),
  ).toEqual({ kind: "duplicate" });
  expect(
    findEffectiveBillingEntitlement(fixture.database, {
      organizationId: fixture.organizationId,
      now: organizationNow,
      priceIds,
    })?.credits.monthly,
  ).toBe(750);
});

it("records operator grants atomically and refuses grants for a closed organization", () => {
  const fixture = setup();
  grantAdminPro(fixture.database, {
    organizationId: fixture.organizationId,
    now: organizationNow,
    grantedBy: "operator-test",
  });
  expect(fixture.database.db.select().from(organizationAuditEvents).all()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        organizationId: fixture.organizationId,
        kind: "operator-grant-created",
        actorJson: JSON.stringify({ kind: "platform-operator", name: "operator-test" }),
      }),
    ]),
  );
  fixture.database.db
    .update(organizations)
    .set({ state: "deleting" })
    .where(eq(organizations.id, fixture.organizationId))
    .run();
  expect(() =>
    grantAdminPro(fixture.database, {
      organizationId: fixture.organizationId,
      now: organizationNow,
      grantedBy: "operator-test",
    }),
  ).toThrow(expect.objectContaining({ code: "ORGANIZATION_NOT_ACTIVE" }));
});
