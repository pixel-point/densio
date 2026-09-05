import { describe, expect, it } from "vitest";

import {
  buildQualityComparisonDecision,
  qualityComparisonConfidence,
} from "../src/media/quality-comparison-decision.ts";

describe("quality comparison Pareto decisions", () => {
  it("removes dominated candidates and chooses a balanced frontier candidate", () => {
    const result = buildQualityComparisonDecision([
      { variantId: "a", estimatedFullVideoBytes: 100, ssim: 0.9 },
      { variantId: "b", estimatedFullVideoBytes: 120, ssim: 0.95 },
      { variantId: "c", estimatedFullVideoBytes: 140, ssim: 0.94 },
      { variantId: "d", estimatedFullVideoBytes: 90, ssim: 0.85 },
    ]);

    expect(result.paretoVariantIds).toEqual(["d", "a", "b"]);
    expect(result.recommendedVariantId).toBe("a");
  });

  it("breaks balanced ties by bytes, quality, then request order", () => {
    expect(
      buildQualityComparisonDecision([
        { variantId: "quality", estimatedFullVideoBytes: 200, ssim: 1 },
        { variantId: "small", estimatedFullVideoBytes: 100, ssim: 0.8 },
      ]).recommendedVariantId,
    ).toBe("small");
    expect(
      buildQualityComparisonDecision([
        { variantId: "first", estimatedFullVideoBytes: 100, ssim: 0.9 },
        { variantId: "second", estimatedFullVideoBytes: 100, ssim: 0.9 },
      ]).recommendedVariantId,
    ).toBe("first");
  });

  it("rejects duplicate variant IDs before producing ambiguous references", () => {
    expect(() =>
      buildQualityComparisonDecision([
        { variantId: "same", estimatedFullVideoBytes: 100, ssim: 0.9 },
        { variantId: "same", estimatedFullVideoBytes: 120, ssim: 0.95 },
      ]),
    ).toThrow(/unique/i);
  });
});

describe("quality comparison confidence", () => {
  it.each([
    [1, 0.8, "low"],
    [3, 0.2, "low"],
    [2, 0.8, "medium"],
    [3, 0.4, "medium"],
    [3, 0.5, "high"],
  ] as const)(
    "classifies %i samples across %f of the source as %s",
    (sampleCount, span, expected) => {
      expect(qualityComparisonConfidence(sampleCount, span)).toBe(expected);
    },
  );
});
