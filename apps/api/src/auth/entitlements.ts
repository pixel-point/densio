import type { MediaCodec, Plan, SubscriptionStatus } from "@ffmpeg-api/shared";

export type StripeSubscriptionStatus = SubscriptionStatus;

export interface Entitlements {
  readonly plan: Plan;
  readonly maxVideoDurationSeconds: 10 | 1_800;
  readonly allowedCodecs: ReadonlyArray<MediaCodec>;
}

const FREE_CODECS: ReadonlyArray<MediaCodec> = Object.freeze(["vp9", "h265"]);
const PRO_CODECS: ReadonlyArray<MediaCodec> = Object.freeze(["vp9", "h265", "av1"]);

export const FREE_ENTITLEMENTS: Entitlements = Object.freeze({
  plan: "free",
  maxVideoDurationSeconds: 10,
  allowedCodecs: FREE_CODECS,
});

export const PRO_ENTITLEMENTS: Entitlements = Object.freeze({
  plan: "pro",
  maxVideoDurationSeconds: 1_800,
  allowedCodecs: PRO_CODECS,
});

export interface EntitlementSource {
  readonly adminGrant: boolean;
  readonly stripeSubscriptionStatus: StripeSubscriptionStatus | null;
}

export const resolveEntitlements = ({ adminGrant, stripeSubscriptionStatus }: EntitlementSource) =>
  adminGrant || stripeSubscriptionStatus === "active" || stripeSubscriptionStatus === "trialing"
    ? PRO_ENTITLEMENTS
    : FREE_ENTITLEMENTS;
