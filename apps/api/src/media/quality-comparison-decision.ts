import type { ComparisonSample } from "@densio/shared";
import { MediaPlanError } from "./media-plan-error.ts";

interface QualityDecisionVariant {
  readonly estimatedFullVideoBytes: number;
  readonly ssim: number;
  readonly variantId: string;
}

interface IndexedVariant extends QualityDecisionVariant {
  readonly requestIndex: number;
}

export const buildQualityComparisonDecision = (variants: ReadonlyArray<QualityDecisionVariant>) => {
  assertDecisionVariants(variants);
  const indexed = variants.map((variant, requestIndex) => ({ ...variant, requestIndex }));
  const frontier = indexed
    .filter((candidate) => !indexed.some((other) => dominates(other, candidate)))
    .toSorted(compareFrontier);
  const recommended = frontier.toSorted(compareBalanced(frontier))[0];
  if (recommended === undefined) {
    throw new MediaPlanError("INVALID_COMPARISON_DECISION", "Comparison variants are required");
  }

  return {
    paretoVariantIds: frontier.map(({ variantId }) => variantId),
    recommendedVariantId: recommended.variantId,
  };
};

export const qualityComparisonConfidence = (sampleCount: number, temporalSpanRatio: number) => {
  if (
    !Number.isSafeInteger(sampleCount) ||
    sampleCount < 1 ||
    sampleCount > 5 ||
    !Number.isFinite(temporalSpanRatio) ||
    temporalSpanRatio < 0 ||
    temporalSpanRatio > 1
  ) {
    throw new MediaPlanError(
      "INVALID_COMPARISON_CONFIDENCE",
      "Comparison confidence coverage is invalid",
    );
  }
  if (sampleCount === 1 || temporalSpanRatio < 0.25) return "low" as const;
  if (sampleCount === 2 || temporalSpanRatio < 0.5) return "medium" as const;

  return "high" as const;
};

export const buildComparisonCoverage = (
  samples: ReadonlyArray<ComparisonSample>,
  sourceDurationSeconds: number,
) => {
  if (
    samples.length === 0 ||
    !Number.isFinite(sourceDurationSeconds) ||
    sourceDurationSeconds <= 0
  ) {
    throw new MediaPlanError(
      "INVALID_COMPARISON_CONFIDENCE",
      "Comparison coverage requires samples and a positive source duration",
    );
  }
  const windows = samples
    .map(({ normalizedStartSeconds, actualSampleDurationSeconds }) => ({
      start: normalizedStartSeconds,
      end: normalizedStartSeconds + actualSampleDurationSeconds,
    }))
    .toSorted((left, right) => left.start - right.start);
  // Overlapping windows form one temporal observation, even if requested several times.
  const independent = windows.reduce<
    ReadonlyArray<{ readonly start: number; readonly end: number }>
  >((merged, window) => {
    const previous = merged.at(-1);
    return previous === undefined || window.start >= previous.end
      ? [...merged, window]
      : [
          ...merged.slice(0, -1),
          { start: previous.start, end: Math.max(previous.end, window.end) },
        ];
  }, []);
  return {
    sampleCount: samples.length,
    independentSampleCount: independent.length,
    temporalSpanRatio: Math.min(
      1,
      ((windows.at(-1)?.start ?? 0) - (windows[0]?.start ?? 0)) / sourceDurationSeconds,
    ),
    sampledDurationRatio: Math.min(
      1,
      independent.reduce((total, window) => total + window.end - window.start, 0) /
        sourceDurationSeconds,
    ),
  };
};

const dominates = (candidate: IndexedVariant, other: IndexedVariant) =>
  candidate.variantId !== other.variantId &&
  candidate.estimatedFullVideoBytes <= other.estimatedFullVideoBytes &&
  candidate.ssim >= other.ssim &&
  (candidate.estimatedFullVideoBytes < other.estimatedFullVideoBytes ||
    candidate.ssim > other.ssim);

const compareFrontier = (left: IndexedVariant, right: IndexedVariant) =>
  left.estimatedFullVideoBytes - right.estimatedFullVideoBytes ||
  right.ssim - left.ssim ||
  left.requestIndex - right.requestIndex;

const compareBalanced = (frontier: ReadonlyArray<IndexedVariant>) => {
  const bytes = frontier.map(({ estimatedFullVideoBytes }) => estimatedFullVideoBytes);
  const scores = frontier.map(({ ssim }) => ssim);
  const minimumBytes = Math.min(...bytes);
  const maximumBytes = Math.max(...bytes);
  const minimumSsim = Math.min(...scores);
  const maximumSsim = Math.max(...scores);

  return (left: IndexedVariant, right: IndexedVariant) => {
    const scoreDifference =
      balancedScore(right, minimumBytes, maximumBytes, minimumSsim, maximumSsim) -
      balancedScore(left, minimumBytes, maximumBytes, minimumSsim, maximumSsim);
    if (Math.abs(scoreDifference) > Number.EPSILON) return scoreDifference;

    return compareFrontier(left, right);
  };
};

const balancedScore = (
  variant: IndexedVariant,
  minimumBytes: number,
  maximumBytes: number,
  minimumSsim: number,
  maximumSsim: number,
) =>
  (normalizeLowerIsBetter(variant.estimatedFullVideoBytes, minimumBytes, maximumBytes) +
    normalizeHigherIsBetter(variant.ssim, minimumSsim, maximumSsim)) /
  2;

const normalizeLowerIsBetter = (value: number, minimum: number, maximum: number) =>
  maximum === minimum ? 1 : (maximum - value) / (maximum - minimum);

const normalizeHigherIsBetter = (value: number, minimum: number, maximum: number) =>
  maximum === minimum ? 1 : (value - minimum) / (maximum - minimum);

const assertDecisionVariants = (variants: ReadonlyArray<QualityDecisionVariant>) => {
  if (variants.length === 0) {
    throw new MediaPlanError("INVALID_COMPARISON_DECISION", "Comparison variants are required");
  }
  const variantIds = variants.map(({ variantId }) => variantId);
  if (new Set(variantIds).size !== variantIds.length) {
    throw new MediaPlanError(
      "INVALID_COMPARISON_DECISION",
      "Comparison variant IDs must be unique",
    );
  }
  variants.forEach(({ estimatedFullVideoBytes, ssim, variantId }) => {
    if (
      variantId.length === 0 ||
      !Number.isSafeInteger(estimatedFullVideoBytes) ||
      estimatedFullVideoBytes < 0 ||
      !Number.isFinite(ssim) ||
      ssim < 0 ||
      ssim > 1
    ) {
      throw new MediaPlanError(
        "INVALID_COMPARISON_DECISION",
        "Comparison decision input is invalid",
      );
    }
  });
};
