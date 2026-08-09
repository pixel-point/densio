import { describe, expect, it } from "vitest";

import {
  BASIC_ENTITLEMENTS,
  FREE_ENTITLEMENTS,
  PREMIUM_ENTITLEMENTS,
  PRO_ENTITLEMENTS,
  resolveEntitlements,
} from "../src/auth/entitlements.ts";

describe("resolveEntitlements", () => {
  it("applies free limits without an active subscription or admin grant", () => {
    expect(
      resolveEntitlements({
        adminGrant: false,
        stripePlan: null,
        stripeSubscriptionStatus: null,
      }),
    ).toEqual(FREE_ENTITLEMENTS);
  });

  it.each(["active", "trialing"] as const)(
    "applies the selected paid tier for a %s Stripe subscription",
    (stripeSubscriptionStatus) => {
      expect(
        resolveEntitlements({ adminGrant: false, stripePlan: "basic", stripeSubscriptionStatus }),
      ).toEqual(BASIC_ENTITLEMENTS);
    },
  );

  it.each([
    "past_due",
    "canceled",
    "unpaid",
    "incomplete",
    "incomplete_expired",
    "paused",
  ] as const)("fails closed for a %s Stripe subscription", (stripeSubscriptionStatus) => {
    expect(
      resolveEntitlements({
        adminGrant: false,
        stripePlan: "premium",
        stripeSubscriptionStatus,
      }),
    ).toEqual(FREE_ENTITLEMENTS);
  });

  it("applies pro limits when an independent admin grant exists", () => {
    expect(
      resolveEntitlements({
        adminGrant: true,
        stripePlan: "premium",
        stripeSubscriptionStatus: "canceled",
      }),
    ).toEqual(PRO_ENTITLEMENTS);
  });

  it("keeps Stripe Pro access when no admin grant exists", () => {
    const entitlements = resolveEntitlements({
      adminGrant: false,
      stripePlan: "premium",
      stripeSubscriptionStatus: "active",
    });

    expect(entitlements).toEqual(PREMIUM_ENTITLEMENTS);
    expect(entitlements.maxVideoDurationSeconds).toBe(1_800);
    expect(entitlements.allowedCodecs).toContain("av1");
  });

  it("gives every tier the same codecs and global duration ceiling", () => {
    expect(FREE_ENTITLEMENTS.maxVideoDurationSeconds).toBe(1_800);
    expect(FREE_ENTITLEMENTS.allowedCodecs).toContain("av1");
    expect(BASIC_ENTITLEMENTS.allowedCodecs).toEqual(FREE_ENTITLEMENTS.allowedCodecs);
    expect(PRO_ENTITLEMENTS.allowedCodecs).toEqual(FREE_ENTITLEMENTS.allowedCodecs);
    expect(PREMIUM_ENTITLEMENTS.allowedCodecs).toEqual(FREE_ENTITLEMENTS.allowedCodecs);
  });
});
