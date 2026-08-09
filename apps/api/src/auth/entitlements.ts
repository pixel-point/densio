import {
  MEDIA_CODEC_POLICY,
  MEDIA_CODECS,
  type MediaCodec,
  type Plan,
  type SubscriptionStatus,
} from "@densio/shared";

export type StripeSubscriptionStatus = SubscriptionStatus;

export interface Entitlements {
  readonly plan: Plan;
  readonly maxVideoDurationSeconds: 1_800;
  readonly allowedCodecs: ReadonlyArray<MediaCodec>;
}

const ALL_PLAN_CODECS = Object.freeze(
  MEDIA_CODECS.filter((codec) => MEDIA_CODEC_POLICY[codec].minimumPlan === "free"),
);

const planEntitlements = (plan: Plan): Entitlements =>
  Object.freeze({
    allowedCodecs: ALL_PLAN_CODECS,
    maxVideoDurationSeconds: 1_800,
    plan,
  });

export const FREE_ENTITLEMENTS = planEntitlements("free");
export const BASIC_ENTITLEMENTS = planEntitlements("basic");
export const PRO_ENTITLEMENTS = planEntitlements("pro");
export const SCALE_ENTITLEMENTS = planEntitlements("scale");

export const PLAN_ENTITLEMENTS = Object.freeze({
  basic: BASIC_ENTITLEMENTS,
  free: FREE_ENTITLEMENTS,
  pro: PRO_ENTITLEMENTS,
  scale: SCALE_ENTITLEMENTS,
});

export interface EntitlementSource {
  readonly adminGrant: boolean;
  readonly stripePlan: Exclude<Plan, "free"> | null;
  readonly stripeSubscriptionStatus: StripeSubscriptionStatus | null;
}

export const resolveEntitlements = ({
  adminGrant,
  stripePlan,
  stripeSubscriptionStatus,
}: EntitlementSource) => {
  if (
    stripePlan !== null &&
    (stripeSubscriptionStatus === "active" || stripeSubscriptionStatus === "trialing")
  ) {
    if (adminGrant && stripePlan === "basic") return PRO_ENTITLEMENTS;
    return PLAN_ENTITLEMENTS[stripePlan];
  }
  if (adminGrant) return PRO_ENTITLEMENTS;
  return FREE_ENTITLEMENTS;
};
