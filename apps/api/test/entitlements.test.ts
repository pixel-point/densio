import { describe, expect, it } from "vitest";

import {
  BASIC_ENTITLEMENTS,
  FREE_ENTITLEMENTS,
  PRO_ENTITLEMENTS,
  SCALE_ENTITLEMENTS,
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
        stripePlan: "scale",
        stripeSubscriptionStatus,
      }),
    ).toEqual(FREE_ENTITLEMENTS);
  });

  it("applies pro limits when an independent admin grant exists", () => {
    expect(
      resolveEntitlements({
        adminGrant: true,
        stripePlan: "scale",
        stripeSubscriptionStatus: "canceled",
      }),
    ).toEqual(PRO_ENTITLEMENTS);
  });

  it("keeps Stripe Scale access when no admin grant exists", () => {
    const entitlements = resolveEntitlements({
      adminGrant: false,
      stripePlan: "scale",
      stripeSubscriptionStatus: "active",
    });

    expect(entitlements).toEqual(SCALE_ENTITLEMENTS);
    expect(entitlements.maxVideoDurationSeconds).toBe(10_800);
    expect(entitlements.allowedCodecs).toContain("av1");
  });

  it("reserves AV1 and longer inputs for every paid tier", () => {
    expect(FREE_ENTITLEMENTS.maxVideoDurationSeconds).toBe(1_800);
    expect(BASIC_ENTITLEMENTS.maxVideoDurationSeconds).toBe(10_800);
    expect(PRO_ENTITLEMENTS.maxVideoDurationSeconds).toBe(10_800);
    expect(SCALE_ENTITLEMENTS.maxVideoDurationSeconds).toBe(10_800);
    expect(FREE_ENTITLEMENTS.allowedCodecs).toEqual(["vp9", "h265"]);
    expect(BASIC_ENTITLEMENTS.allowedCodecs).toEqual(["vp9", "h265", "av1"]);
    expect(PRO_ENTITLEMENTS.allowedCodecs).toEqual(["vp9", "h265", "av1"]);
    expect(SCALE_ENTITLEMENTS.allowedCodecs).toEqual(["vp9", "h265", "av1"]);
  });
});
