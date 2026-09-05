import { expect, it } from "vitest";
import {
  normalizeQualityComparisonOptions,
  resolveQualityComparisonSamples,
} from "../src/media/quality-comparison-plan.ts";

it("resolves a single automatic sample and defaults metrics to SSIM", () => {
  const normalized = normalizeQualityComparisonOptions({
    variants: [
      { codec: "vp9", crf: 36 },
      { codec: "h265", crf: 24 },
    ],
    samples: { mode: "auto", count: 1 },
  });
  expect(normalized.objectiveMetrics).toEqual(["ssim"]);
  expect(normalized).not.toHaveProperty("legacy");
  expect(resolveQualityComparisonSamples({ ...normalized, sourceDurationSeconds: 10 })).toEqual([
    { sampleId: "sample-1", normalizedStartSeconds: 4.5, actualSampleDurationSeconds: 1 },
  ]);
});
