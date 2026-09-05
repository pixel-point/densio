import { expect, it } from "vitest";
import {
  buildComparisonCoverage,
  qualityComparisonConfidence,
} from "../src/media/quality-comparison-decision.ts";

it("does not count overlapping windows as independent coverage", () => {
  const coverage = buildComparisonCoverage(
    [
      { sampleId: "a", normalizedStartSeconds: 0, actualSampleDurationSeconds: 3 },
      { sampleId: "b", normalizedStartSeconds: 1, actualSampleDurationSeconds: 3 },
      { sampleId: "c", normalizedStartSeconds: 80, actualSampleDurationSeconds: 3 },
    ],
    100,
  );
  expect(coverage).toEqual({
    sampleCount: 3,
    independentSampleCount: 2,
    temporalSpanRatio: 0.8,
    sampledDurationRatio: 0.07,
  });
  expect(
    qualityComparisonConfidence(coverage.independentSampleCount, coverage.temporalSpanRatio),
  ).toBe("medium");
});

it("keeps clustered and single-sample confidence low", () => {
  for (const starts of [[0], [0, 3, 6]]) {
    const coverage = buildComparisonCoverage(
      starts.map((start, index) => ({
        sampleId: String(index),
        normalizedStartSeconds: start,
        actualSampleDurationSeconds: 1,
      })),
      100,
    );
    expect(
      qualityComparisonConfidence(coverage.independentSampleCount, coverage.temporalSpanRatio),
    ).toBe("low");
  }
});
