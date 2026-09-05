import { randomUUID } from "node:crypto";

import { PAID_PLANS, PLAN_CATALOG, type PaidPlan } from "@densio/shared";
import { and, asc, desc, eq, isNull } from "drizzle-orm";

import { creditsFromUnits, monthlyCreditUnits } from "./credit-units.ts";
import {
  resolveEntitlements,
  type Entitlements,
  type StripeSubscriptionStatus,
} from "../auth/entitlements.ts";
import type { Database } from "../database/database.ts";
import { reservedCreditUnits, usedCreditUnits } from "../database/job-credit-ledger.ts";
import {
  adminGrants,
  jobCreditEntries,
  stripeCustomers,
  stripeEvents,
  stripeSubscriptions,
  organizations,
} from "../database/schema.ts";
import { type BillingEvent, normalizeStripeSubscriptionStatus } from "./stripe-gateway.ts";
import { appendOrganizationAudit } from "../database/organization-audit-repository.ts";
import { organizationFailure } from "../organizations/organization-errors.ts";

type BillingTransaction = Parameters<Parameters<Database["db"]["transaction"]>[0]>[0];

export interface BillingAccount {
  readonly customerId: string | null;
  readonly billingEmail: string;
  readonly organizationId: string;
}

export interface ProGrant {
  readonly billingEmail: string;
  readonly grantedAt: number;
  readonly grantedBy: string;
  readonly organizationId: string;
}

export interface EffectiveBillingEntitlement {
  readonly organizationId: string;
  readonly billingEmail: string;
  readonly credits: {
    readonly available: number;
    readonly monthly: number;
    readonly reserved: number;
    readonly resetsAt: number;
    readonly used: number;
  };
  readonly entitlements: Entitlements;
  readonly renewsAt: number | null;
  readonly source: "free" | "admin" | "stripe" | "both";
  readonly subscriptionStatus: StripeSubscriptionStatus | null;
}

export type BillingPriceIds = Readonly<Record<PaidPlan, string>>;

export type WebhookProcessOutcome =
  | { readonly kind: "processed" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "unmatched" };

export type GrantProOutcome =
  | { readonly kind: "granted"; readonly created: boolean }
  | { readonly kind: "organization-missing" };

export const findBillingAccount = (
  { db }: Database,
  organizationId: string,
): BillingAccount | undefined => {
  const organization = db
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .get();
  if (organization === undefined) return undefined;
  const customer = db
    .select()
    .from(stripeCustomers)
    .where(eq(stripeCustomers.organizationId, organizationId))
    .get();
  return {
    customerId: customer?.customerId ?? null,
    billingEmail: organization.billingEmail,
    organizationId,
  };
};

export const processBillingWebhook = (
  { db }: Database,
  event: BillingEvent,
  now: number,
): WebhookProcessOutcome =>
  db.transaction((transaction) => applyBillingWebhook(transaction, event, now), {
    behavior: "immediate",
  });

export const applyBillingWebhook = (
  transaction: BillingTransaction,
  event: BillingEvent,
  now: number,
): WebhookProcessOutcome => {
  const duplicate = transaction
    .select({ eventId: stripeEvents.eventId })
    .from(stripeEvents)
    .where(eq(stripeEvents.eventId, event.eventId))
    .get();
  if (duplicate !== undefined) return { kind: "duplicate" };
  if (!applyBillingEvent(transaction, event, now)) return { kind: "unmatched" };

  transaction
    .insert(stripeEvents)
    .values({ eventId: event.eventId, eventType: event.kind, processedAt: now })
    .run();
  return { kind: "processed" };
};

export const grantAdminPro = (
  { db }: Database,
  input: { readonly grantedBy: string; readonly now: number; readonly organizationId: string },
): GrantProOutcome =>
  db.transaction(
    (transaction) => {
      const organization = transaction
        .select({ id: organizations.id, state: organizations.state })
        .from(organizations)
        .where(eq(organizations.id, input.organizationId))
        .get();
      if (organization === undefined) return { kind: "organization-missing" };
      if (organization.state !== "active")
        throw organizationFailure(
          "ORGANIZATION_NOT_ACTIVE",
          "A closed organization cannot receive a new grant.",
        );
      const existing = transaction
        .select({ id: adminGrants.id })
        .from(adminGrants)
        .where(
          and(eq(adminGrants.organizationId, input.organizationId), isNull(adminGrants.revokedAt)),
        )
        .get();
      if (existing !== undefined) return { created: false, kind: "granted" };

      transaction
        .insert(adminGrants)
        .values({
          grantedAt: input.now,
          grantedBy: input.grantedBy,
          id: randomUUID(),
          organizationId: input.organizationId,
        })
        .run();
      appendOrganizationAudit(transaction, {
        organizationId: input.organizationId,
        kind: "operator-grant-created",
        actor: { kind: "platform-operator", name: input.grantedBy },
        targetId: input.organizationId,
        now: input.now,
        correlationId: randomUUID(),
      });
      return { created: true, kind: "granted" };
    },
    { behavior: "immediate" },
  );

export const revokeAdminPro = (
  { db }: Database,
  input: { readonly now: number; readonly organizationId: string; readonly revokedBy: string },
) =>
  db.transaction(
    (transaction) => {
      const organization = transaction
        .select()
        .from(organizations)
        .where(eq(organizations.id, input.organizationId))
        .get();
      if (organization === undefined)
        throw organizationFailure("ORGANIZATION_NOT_FOUND", "Organization not found.");
      const revoked = transaction
        .update(adminGrants)
        .set({ revokedAt: input.now })
        .where(
          and(eq(adminGrants.organizationId, input.organizationId), isNull(adminGrants.revokedAt)),
        )
        .returning({ id: adminGrants.id })
        .all().length;
      if (revoked > 0)
        appendOrganizationAudit(transaction, {
          organizationId: input.organizationId,
          kind: "operator-grant-revoked",
          actor: { kind: "platform-operator", name: input.revokedBy },
          targetId: input.organizationId,
          now: input.now,
          correlationId: randomUUID(),
        });
      return revoked;
    },
    { behavior: "immediate" },
  );

export const listAdminProGrants = ({ db }: Database): ReadonlyArray<ProGrant> =>
  db
    .select({
      billingEmail: organizations.billingEmail,
      grantedAt: adminGrants.grantedAt,
      grantedBy: adminGrants.grantedBy,
      organizationId: adminGrants.organizationId,
    })
    .from(adminGrants)
    .innerJoin(organizations, eq(organizations.id, adminGrants.organizationId))
    .where(isNull(adminGrants.revokedAt))
    .orderBy(asc(organizations.billingEmail))
    .all();

export const findEffectiveBillingEntitlement = (
  { db }: Database,
  input: {
    readonly now: number;
    readonly priceIds: BillingPriceIds;
    readonly organizationId: string;
  },
): EffectiveBillingEntitlement | undefined => {
  const organization = db
    .select()
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .get();
  if (organization === undefined) return undefined;
  const hasAdminGrant =
    db
      .select({ id: adminGrants.id })
      .from(adminGrants)
      .where(
        and(eq(adminGrants.organizationId, input.organizationId), isNull(adminGrants.revokedAt)),
      )
      .get() !== undefined;
  const subscription = db
    .select({
      currentPeriodEnd: stripeSubscriptions.currentPeriodEnd,
      priceId: stripeSubscriptions.priceId,
      status: stripeSubscriptions.status,
      updatedAt: stripeSubscriptions.updatedAt,
    })
    .from(stripeSubscriptions)
    .where(eq(stripeSubscriptions.organizationId, input.organizationId))
    .orderBy(desc(stripeSubscriptions.updatedAt))
    .all()
    .flatMap((candidate) => {
      const plan = planForPrice(input.priceIds, candidate.priceId);
      return plan === null
        ? []
        : [{ ...candidate, plan, status: normalizeStripeSubscriptionStatus(candidate.status) }];
    })
    .toSorted(compareSubscriptions)[0];
  const stripePlan = subscription?.plan ?? null;
  const subscriptionStatus = subscription?.status ?? null;
  const hasStripeSubscription =
    stripePlan !== null && (subscriptionStatus === "active" || subscriptionStatus === "trialing");
  const entitlements = resolveEntitlements({
    adminGrant: hasAdminGrant,
    stripePlan,
    stripeSubscriptionStatus: subscriptionStatus,
  });
  const creditPeriod = utcCreditPeriod(input.now);
  const totals = db
    .select({ reservedUnits: reservedCreditUnits, usedUnits: usedCreditUnits })
    .from(jobCreditEntries)
    .where(
      and(
        eq(jobCreditEntries.organizationId, input.organizationId),
        eq(jobCreditEntries.periodStart, creditPeriod.start),
      ),
    )
    .get() ?? { reservedUnits: 0, usedUnits: 0 };
  const monthly = PLAN_CATALOG[entitlements.plan].monthlyCredits;
  const availableUnits = Math.max(
    0,
    monthlyCreditUnits(monthly) - totals.reservedUnits - totals.usedUnits,
  );

  return {
    organizationId: organization.id,
    billingEmail: organization.billingEmail,
    credits: {
      available: creditsFromUnits(availableUnits),
      monthly,
      reserved: creditsFromUnits(totals.reservedUnits),
      resetsAt: creditPeriod.end,
      used: creditsFromUnits(totals.usedUnits),
    },
    entitlements,
    renewsAt: subscription?.currentPeriodEnd ?? null,
    source: getEntitlementSource(hasAdminGrant, hasStripeSubscription),
    subscriptionStatus,
  };
};

const planForPrice = (priceIds: BillingPriceIds, priceId: string) =>
  PAID_PLANS.find((plan) => priceIds[plan] === priceId) ?? null;

const compareSubscriptions = (
  left: {
    readonly plan: PaidPlan;
    readonly status: StripeSubscriptionStatus;
    readonly updatedAt: number;
  },
  right: {
    readonly plan: PaidPlan;
    readonly status: StripeSubscriptionStatus;
    readonly updatedAt: number;
  },
) => {
  const leftActive = left.status === "active" || left.status === "trialing";
  const rightActive = right.status === "active" || right.status === "trialing";
  if (leftActive !== rightActive) return leftActive ? -1 : 1;
  if (leftActive && rightActive) {
    const rankDifference = PLAN_CATALOG[right.plan].rank - PLAN_CATALOG[left.plan].rank;
    if (rankDifference !== 0) return rankDifference;
  }
  return right.updatedAt - left.updatedAt;
};

const utcCreditPeriod = (now: number) => {
  const date = new Date(now);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  return { end: Date.UTC(year, month + 1, 1), start: Date.UTC(year, month, 1) };
};

const applyBillingEvent = (transaction: BillingTransaction, event: BillingEvent, now: number) => {
  if (event.kind === "ignored") return true;
  const customer = transaction
    .select()
    .from(stripeCustomers)
    .where(eq(stripeCustomers.customerId, event.customerId))
    .get();
  if (
    customer === undefined ||
    (event.organizationId !== null && event.organizationId !== customer.organizationId)
  )
    return false;
  const organizationId = customer.organizationId;
  const organization = transaction
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .get();
  if (organization === undefined) return false;
  if (event.kind === "customer-map") return organization.state === "active";
  if (
    organization.state !== "active" &&
    event.status !== "canceled" &&
    event.status !== "incomplete_expired"
  )
    return false;
  const previous = transaction
    .select()
    .from(stripeSubscriptions)
    .where(eq(stripeSubscriptions.subscriptionId, event.subscriptionId))
    .get();
  if (
    previous !== undefined &&
    (previous.organizationId !== organizationId || previous.customerId !== event.customerId)
  )
    return false;
  transaction
    .insert(stripeSubscriptions)
    .values({
      cancelAtPeriodEnd: event.cancelAtPeriodEnd,
      currentPeriodEnd: event.currentPeriodEnd,
      customerId: event.customerId,
      priceId: event.priceId,
      status: event.status,
      subscriptionId: event.subscriptionId,
      updatedAt: now,
      organizationId,
    })
    .onConflictDoUpdate({
      set: {
        cancelAtPeriodEnd: event.cancelAtPeriodEnd,
        currentPeriodEnd: event.currentPeriodEnd,
        customerId: event.customerId,
        priceId: event.priceId,
        status: event.status,
        updatedAt: now,
        organizationId,
      },
      target: stripeSubscriptions.subscriptionId,
    })
    .run();
  return true;
};

const getEntitlementSource = (admin: boolean, stripe: boolean) => {
  if (admin && stripe) return "both" as const;
  if (admin) return "admin" as const;
  return stripe ? ("stripe" as const) : ("free" as const);
};
