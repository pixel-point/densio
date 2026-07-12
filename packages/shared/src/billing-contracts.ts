import { Schema } from "effect";

import { HttpUrlSchema, IsoTimestampSchema, PlanSchema } from "./common-contracts.ts";

const CheckoutSessionResponseSchema = Schema.Struct({
  kind: Schema.Literal("checkout"),
  url: HttpUrlSchema,
  expiresAt: IsoTimestampSchema,
});

const PortalSessionResponseSchema = Schema.Struct({
  kind: Schema.Literal("portal"),
  url: HttpUrlSchema,
  expiresAt: IsoTimestampSchema,
});

export const BillingSessionResponseSchema = Schema.Union([
  CheckoutSessionResponseSchema,
  PortalSessionResponseSchema,
]);
export type BillingSessionResponse = typeof BillingSessionResponseSchema.Type;

export const EntitlementSourceSchema = Schema.Literals(["free", "stripe", "admin", "both"]);
export type EntitlementSource = typeof EntitlementSourceSchema.Type;

export const SubscriptionStatusSchema = Schema.Literals([
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
]);
export type SubscriptionStatus = typeof SubscriptionStatusSchema.Type;

export const BillingStatusSchema = Schema.Struct({
  plan: PlanSchema,
  entitlementSource: EntitlementSourceSchema,
  subscriptionStatus: Schema.optionalKey(SubscriptionStatusSchema),
  renewsAt: Schema.optionalKey(IsoTimestampSchema),
});
export type BillingStatus = typeof BillingStatusSchema.Type;
