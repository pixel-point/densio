import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, isNull } from "drizzle-orm";

import {
  resolveEntitlements,
  type Entitlements,
  type StripeSubscriptionStatus,
} from "../auth/entitlements.ts";
import type { Database } from "../database/database.ts";
import {
  adminGrants,
  stripeCustomers,
  stripeEvents,
  stripeSubscriptions,
  users,
} from "../database/schema.ts";
import { type BillingWebhookEvent, normalizeStripeSubscriptionStatus } from "./stripe-gateway.ts";

type BillingTransaction = Parameters<Parameters<Database["db"]["transaction"]>[0]>[0];

export interface BillingAccount {
  readonly customerId: string | null;
  readonly email: string;
  readonly userId: string;
}

export interface ProGrant {
  readonly email: string;
  readonly grantedAt: number;
  readonly grantedBy: string;
  readonly userId: string;
}

export interface EffectiveBillingEntitlement {
  readonly entitlements: Entitlements;
  readonly renewsAt: number | null;
  readonly source: "free" | "admin" | "stripe" | "both";
  readonly subscriptionStatus: StripeSubscriptionStatus | null;
}

export type WebhookProcessOutcome =
  | { readonly kind: "processed" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "unmatched" };

export type GrantProOutcome =
  | { readonly kind: "granted"; readonly created: boolean }
  | { readonly kind: "user-missing" };

export const findBillingAccount = (
  { db }: Database,
  userId: string,
): BillingAccount | undefined => {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (user === undefined) return undefined;
  const customer = db
    .select()
    .from(stripeCustomers)
    .where(eq(stripeCustomers.userId, userId))
    .get();
  return { customerId: customer?.customerId ?? null, email: user.email, userId };
};

export const processBillingWebhook = (
  { db }: Database,
  event: BillingWebhookEvent,
  now: number,
): WebhookProcessOutcome =>
  db.transaction(
    (transaction) => {
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
    },
    { behavior: "immediate" },
  );

export const grantAdminPro = (
  { db }: Database,
  input: { readonly grantedBy: string; readonly now: number; readonly userId: string },
): GrantProOutcome =>
  db.transaction(
    (transaction) => {
      const user = transaction
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, input.userId))
        .get();
      if (user === undefined) return { kind: "user-missing" };
      const existing = transaction
        .select({ id: adminGrants.id })
        .from(adminGrants)
        .where(and(eq(adminGrants.userId, input.userId), isNull(adminGrants.revokedAt)))
        .get();
      if (existing !== undefined) return { created: false, kind: "granted" };

      transaction
        .insert(adminGrants)
        .values({
          grantedAt: input.now,
          grantedBy: input.grantedBy,
          id: randomUUID(),
          userId: input.userId,
        })
        .run();
      return { created: true, kind: "granted" };
    },
    { behavior: "immediate" },
  );

export const revokeAdminPro = (
  { db }: Database,
  input: { readonly now: number; readonly userId: string },
) =>
  db
    .update(adminGrants)
    .set({ revokedAt: input.now })
    .where(and(eq(adminGrants.userId, input.userId), isNull(adminGrants.revokedAt)))
    .returning({ id: adminGrants.id })
    .all().length;

export const listAdminProGrants = ({ db }: Database): ReadonlyArray<ProGrant> =>
  db
    .select({
      email: users.email,
      grantedAt: adminGrants.grantedAt,
      grantedBy: adminGrants.grantedBy,
      userId: adminGrants.userId,
    })
    .from(adminGrants)
    .innerJoin(users, eq(users.id, adminGrants.userId))
    .where(isNull(adminGrants.revokedAt))
    .orderBy(asc(users.email))
    .all();

export const findEffectiveBillingEntitlement = (
  { db }: Database,
  input: { readonly proPriceId: string; readonly userId: string },
): EffectiveBillingEntitlement | undefined => {
  const user = db.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).get();
  if (user === undefined) return undefined;
  const hasAdminGrant =
    db
      .select({ id: adminGrants.id })
      .from(adminGrants)
      .where(and(eq(adminGrants.userId, input.userId), isNull(adminGrants.revokedAt)))
      .get() !== undefined;
  const subscription = db
    .select({
      currentPeriodEnd: stripeSubscriptions.currentPeriodEnd,
      status: stripeSubscriptions.status,
    })
    .from(stripeSubscriptions)
    .where(
      and(
        eq(stripeSubscriptions.userId, input.userId),
        eq(stripeSubscriptions.priceId, input.proPriceId),
      ),
    )
    .orderBy(desc(stripeSubscriptions.updatedAt))
    .get();
  const subscriptionStatus =
    subscription === undefined ? null : normalizeStripeSubscriptionStatus(subscription.status);
  const hasStripeSubscription =
    subscriptionStatus === "active" || subscriptionStatus === "trialing";

  return {
    entitlements: resolveEntitlements({
      adminGrant: hasAdminGrant,
      stripeSubscriptionStatus: hasStripeSubscription ? "active" : null,
    }),
    renewsAt: subscription?.currentPeriodEnd ?? null,
    source: getEntitlementSource(hasAdminGrant, hasStripeSubscription),
    subscriptionStatus,
  };
};

const applyBillingEvent = (
  transaction: BillingTransaction,
  event: BillingWebhookEvent,
  now: number,
) => {
  if (event.kind === "ignored" || event.kind === "subscription-delete") {
    if (event.kind === "subscription-delete") {
      transaction
        .delete(stripeSubscriptions)
        .where(eq(stripeSubscriptions.subscriptionId, event.subscriptionId))
        .run();
    }
    return true;
  }
  if (event.kind === "customer-map") {
    if (!userExists(transaction, event.userId)) return false;
    upsertCustomer(transaction, event.userId, event.customerId, now);
    return true;
  }

  const userId =
    event.userId ??
    transaction
      .select({ userId: stripeCustomers.userId })
      .from(stripeCustomers)
      .where(eq(stripeCustomers.customerId, event.customerId))
      .get()?.userId;
  if (userId === undefined || !userExists(transaction, userId)) return false;
  upsertCustomer(transaction, userId, event.customerId, now);
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
      userId,
    })
    .onConflictDoUpdate({
      set: {
        cancelAtPeriodEnd: event.cancelAtPeriodEnd,
        currentPeriodEnd: event.currentPeriodEnd,
        customerId: event.customerId,
        priceId: event.priceId,
        status: event.status,
        updatedAt: now,
        userId,
      },
      target: stripeSubscriptions.subscriptionId,
    })
    .run();
  return true;
};

const userExists = (transaction: BillingTransaction, userId: string) =>
  transaction.select({ id: users.id }).from(users).where(eq(users.id, userId)).get() !== undefined;

const upsertCustomer = (
  transaction: BillingTransaction,
  userId: string,
  customerId: string,
  now: number,
) => {
  transaction
    .insert(stripeCustomers)
    .values({ createdAt: now, customerId, userId })
    .onConflictDoUpdate({
      set: { customerId },
      target: stripeCustomers.userId,
    })
    .run();
};

const getEntitlementSource = (admin: boolean, stripe: boolean) => {
  if (admin && stripe) return "both" as const;
  if (admin) return "admin" as const;
  return stripe ? ("stripe" as const) : ("free" as const);
};
