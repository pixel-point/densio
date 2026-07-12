import { describe, expect, it } from "vitest";

import {
  FREE_ENTITLEMENTS,
  PRO_ENTITLEMENTS,
  resolveEntitlements,
} from "../src/auth/entitlements.ts";

describe("resolveEntitlements", () => {
  it("applies free limits without an active subscription or admin grant", () => {
    expect(resolveEntitlements({ adminGrant: false, stripeSubscriptionStatus: null })).toEqual(
      FREE_ENTITLEMENTS,
    );
  });

  it.each(["active", "trialing"] as const)(
    "applies pro limits for a %s Stripe subscription",
    (stripeSubscriptionStatus) => {
      expect(resolveEntitlements({ adminGrant: false, stripeSubscriptionStatus })).toEqual(
        PRO_ENTITLEMENTS,
      );
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
    expect(resolveEntitlements({ adminGrant: false, stripeSubscriptionStatus })).toEqual(
      FREE_ENTITLEMENTS,
    );
  });

  it("applies pro limits when an independent admin grant exists", () => {
    expect(resolveEntitlements({ adminGrant: true, stripeSubscriptionStatus: "canceled" })).toEqual(
      PRO_ENTITLEMENTS,
    );
  });

  it("keeps Stripe Pro access when no admin grant exists", () => {
    const entitlements = resolveEntitlements({
      adminGrant: false,
      stripeSubscriptionStatus: "active",
    });

    expect(entitlements.maxVideoDurationSeconds).toBe(1_800);
    expect(entitlements.allowedCodecs).toContain("av1");
  });

  it("limits free accounts to ten seconds and excludes AV1", () => {
    expect(FREE_ENTITLEMENTS.maxVideoDurationSeconds).toBe(10);
    expect(FREE_ENTITLEMENTS.allowedCodecs).not.toContain("av1");
  });
});
