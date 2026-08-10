import type { FrameRatePolicy } from "@densio/shared";

import { MediaPlanError } from "./media-plan-error.ts";

export interface RationalFrameRate {
  readonly denominator: number;
  readonly numerator: number;
}

const MAXIMUM_WEB_FRAME_RATE = 30;
const CADENCE_DIVISOR_MINIMUM_FRAME_RATE = 50;

export const requiresFrameRateDecision = (source: RationalFrameRate) => {
  assertRationalFrameRate(source);
  return source.numerator / source.denominator > MAXIMUM_WEB_FRAME_RATE;
};

export const buildFrameRateFilter = (
  source: RationalFrameRate | undefined,
  policy: FrameRatePolicy | undefined,
) => {
  if (policy === undefined || policy.mode === "preserve") return undefined;
  if (policy.mode !== "cap" || policy.maximum !== 30) {
    throw new MediaPlanError("INVALID_FRAME_RATE", "Frame-rate policy is invalid");
  }
  if (source === undefined) {
    throw new MediaPlanError(
      "FRAME_RATE_ANALYSIS_REQUIRED",
      "Source frame-rate analysis is required when applying a cap",
    );
  }
  assertRationalFrameRate(source);
  const framesPerSecond = source.numerator / source.denominator;
  if (framesPerSecond <= policy.maximum) return undefined;

  if (framesPerSecond < CADENCE_DIVISOR_MINIMUM_FRAME_RATE) {
    return `fps=${policy.maximum}/1`;
  }

  const divisor = Math.max(2, Math.round(framesPerSecond / policy.maximum));
  if (framesPerSecond / divisor > policy.maximum) {
    return `fps=${policy.maximum}/1`;
  }
  const denominator = source.denominator * divisor;
  if (!Number.isSafeInteger(denominator)) {
    throw new MediaPlanError("INVALID_FRAME_RATE", "Resolved frame-rate denominator is invalid");
  }
  const commonDivisor = greatestCommonDivisor(source.numerator, denominator);
  return `fps=${source.numerator / commonDivisor}/${denominator / commonDivisor}`;
};

const assertRationalFrameRate = ({ denominator, numerator }: RationalFrameRate) => {
  if (
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    numerator <= 0 ||
    denominator <= 0
  ) {
    throw new MediaPlanError("INVALID_FRAME_RATE", "Source frame rate is invalid");
  }
};

const greatestCommonDivisor = (left: number, right: number): number =>
  right === 0 ? left : greatestCommonDivisor(right, left % right);
