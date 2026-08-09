import { CREDIT_UNITS_PER_CREDIT, MINIMUM_JOB_CREDIT_UNITS } from "./credit-units.ts";

interface VideoDimensions {
  readonly height: number;
  readonly width: number;
}

interface CompressionCreditInput {
  readonly codecCount: number;
  readonly durationSeconds: number;
  readonly output: VideoDimensions;
  readonly source: VideoDimensions;
}

const REFERENCE_PIXELS = 1920 * 1080;
const ROUNDING_UNITS = 5;

export const compressionCreditUnits = (input: CompressionCreditInput) => {
  const inputPixels = input.source.width * input.source.height;
  const outputPixels = input.output.width * input.output.height;
  const resolutionWork = (inputPixels + outputPixels) / (2 * REFERENCE_PIXELS);
  const rawUnits =
    (input.durationSeconds / 300) * resolutionWork * input.codecCount * CREDIT_UNITS_PER_CREDIT;

  return Math.max(MINIMUM_JOB_CREDIT_UNITS, Math.ceil(rawUnits / ROUNDING_UNITS) * ROUNDING_UNITS);
};
