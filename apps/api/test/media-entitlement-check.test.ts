import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { FREE_ENTITLEMENTS, PRO_ENTITLEMENTS } from "../src/auth/entitlements.ts";
import { validateMediaEntitlements } from "../src/media/inspection/media-entitlement-check.ts";

describe("media entitlement checks", () => {
  it("accepts the exact free duration limit with both default codecs", async () => {
    await expect(
      Effect.runPromise(
        validateMediaEntitlements({ durationSeconds: 10 }, ["vp9", "h265"], FREE_ENTITLEMENTS),
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects media even fractionally beyond the plan duration", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        validateMediaEntitlements({ durationSeconds: 10.000_001 }, ["vp9"], FREE_ENTITLEMENTS),
      ),
    );

    expect(error).toMatchObject({
      _tag: "MediaInspectionError",
      reason: "duration-limit-exceeded",
    });
  });

  it("rejects AV1 for free accounts even when another requested codec is allowed", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        validateMediaEntitlements({ durationSeconds: 5 }, ["vp9", "av1"], FREE_ENTITLEMENTS),
      ),
    );

    expect(error).toMatchObject({ reason: "codec-not-entitled" });
  });

  it("accepts AV1 and thirty-minute media for pro accounts", async () => {
    await expect(
      Effect.runPromise(
        validateMediaEntitlements({ durationSeconds: 1_800 }, ["av1"], PRO_ENTITLEMENTS),
      ),
    ).resolves.toBeUndefined();
  });
});
