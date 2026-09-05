import { Schema } from "effect";
import { NonNegativeFiniteSchema, PositiveIntegerSchema } from "./common-contracts.ts";
import {
  Av1CrfSchema,
  H265CrfSchema,
  MediaBitDepthSchema,
  TransformOptionsSchema,
  Vp9CrfSchema,
} from "./media-options.ts";

import { MediaPositionSchema } from "./media-position.ts";
export const ComparisonPositionSchema = MediaPositionSchema;
export type ComparisonPosition = typeof ComparisonPositionSchema.Type;

export const ComparisonMatrixVariantSchema = Schema.Union([
  Schema.Struct({ codec: Schema.Literal("vp9"), crf: Vp9CrfSchema }),
  Schema.Struct({ codec: Schema.Literal("h265"), crf: H265CrfSchema }),
  Schema.Struct({ codec: Schema.Literal("av1"), crf: Av1CrfSchema }),
]);
export type ComparisonMatrixVariant = typeof ComparisonMatrixVariantSchema.Type;

const ComparisonMatrixVariantsSchema = Schema.Array(ComparisonMatrixVariantSchema).check(
  Schema.isMinLength(2),
  Schema.isMaxLength(8),
  Schema.makeFilter((variants) => {
    const pairs = variants.map(({ codec, crf }) => `${codec}:${crf}`);

    if (new Set(pairs).size !== pairs.length) {
      return "Comparison codec and CRF pairs must be unique";
    }
  }),
);

const ComparisonSampleCountSchema = PositiveIntegerSchema.check(
  Schema.isBetween({ minimum: 1, maximum: 5 }),
);

const ComparisonPositionsSchema = Schema.Array(ComparisonPositionSchema).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(5),
  Schema.makeFilter((positions) => {
    const keys = positions.map((position) => JSON.stringify(position));

    if (new Set(keys).size !== keys.length) return "Comparison sample positions must be unique";
  }),
);

export const ComparisonSamplesSchema = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("auto"), count: ComparisonSampleCountSchema }),
  Schema.Struct({ mode: Schema.Literal("positions"), positions: ComparisonPositionsSchema }),
]);
export type ComparisonSamples = typeof ComparisonSamplesSchema.Type;

const ResolvedComparisonSampleDurationSchema = Schema.Finite.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(3),
);

export const ResolvedComparisonSampleSchema = Schema.Struct({
  sampleId: Schema.NonEmptyString.check(Schema.isMaxLength(100)),
  normalizedStartSeconds: NonNegativeFiniteSchema,
  actualSampleDurationSeconds: ResolvedComparisonSampleDurationSchema,
});
export type ResolvedComparisonSample = typeof ResolvedComparisonSampleSchema.Type;

const ResolvedComparisonSamplesSchema = Schema.Array(ResolvedComparisonSampleSchema).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(5),
  Schema.makeFilter((samples) => {
    const sampleIds = samples.map(({ sampleId }) => sampleId);
    if (new Set(sampleIds).size !== sampleIds.length) return "Resolved sample IDs must be unique";
  }),
);

export const ComparisonObjectiveMetricsSchema = Schema.UniqueArray(
  Schema.Literals(["ssim", "psnr"]),
).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2),
  Schema.makeFilter((metrics) => {
    if (!metrics.includes("ssim")) return "Comparison objective metrics must include SSIM";
  }),
);
export type ComparisonObjectiveMetrics = typeof ComparisonObjectiveMetricsSchema.Type;

export const CompareQualityOptionsSchema = Schema.Struct({
  bitDepth: Schema.optionalKey(MediaBitDepthSchema),
  variants: ComparisonMatrixVariantsSchema,
  samples: Schema.optionalKey(ComparisonSamplesSchema),
  objectiveMetrics: Schema.optionalKey(ComparisonObjectiveMetricsSchema),
  durationSeconds: Schema.optionalKey(
    Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
  ),
  transform: Schema.optionalKey(TransformOptionsSchema),
});
export type CompareQualityOptions = typeof CompareQualityOptionsSchema.Type;

export const ResolvedCompareQualityOptionsSchema = Schema.Struct({
  // Do not insert a default while decoding an existing immutable snapshot.
  bitDepth: Schema.optionalKey(MediaBitDepthSchema),
  variants: ComparisonMatrixVariantsSchema,
  objectiveMetrics: ComparisonObjectiveMetricsSchema,
  samples: ResolvedComparisonSamplesSchema,
  transform: Schema.optionalKey(TransformOptionsSchema),
});
export type ResolvedCompareQualityOptions = typeof ResolvedCompareQualityOptionsSchema.Type;
