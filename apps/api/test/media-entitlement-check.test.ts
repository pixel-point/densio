import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { FREE_ENTITLEMENTS, PRO_ENTITLEMENTS } from "../src/auth/entitlements.ts";
import { validateMediaEntitlements } from "../src/media/inspection/media-entitlement-check.ts";

describe("media entitlement checks", () => {
  it("accepts the exact global duration limit with Free codecs", async () => {
    await expect(
      Effect.runPromise(
        validateMediaEntitlements({ durationSeconds: 1_800 }, ["vp9", "h265"], FREE_ENTITLEMENTS),
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects AV1 for Free accounts", async () => {
    const error = await Effect.runPromise(
      Effect.flip(validateMediaEntitlements({ durationSeconds: 1 }, ["av1"], FREE_ENTITLEMENTS)),
    );

    expect(error).toMatchObject({
      _tag: "MediaInspectionError",
      message: "AV1 is not available on the free plan.",
      reason: "codec-not-entitled",
    });
  });

  it("rejects media even fractionally beyond the plan duration", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        validateMediaEntitlements({ durationSeconds: 1_800.000_001 }, ["vp9"], FREE_ENTITLEMENTS),
      ),
    );

    expect(error).toMatchObject({
      _tag: "MediaInspectionError",
      reason: "duration-limit-exceeded",
    });
  });

  it("accepts AV1 at the exact paid duration limit", async () => {
    await expect(
      Effect.runPromise(
        validateMediaEntitlements({ durationSeconds: 10_800 }, ["av1"], PRO_ENTITLEMENTS),
      ),
    ).resolves.toBeUndefined();
  });
});
