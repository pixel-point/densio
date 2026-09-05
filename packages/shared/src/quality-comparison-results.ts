import { Schema } from "effect";
import {
  IdentifierSchema,
  NonNegativeFiniteSchema,
  NonNegativeIntegerSchema,
  PositiveFiniteSchema,
  PositiveIntegerSchema,
} from "./common-contracts.ts";
import { Av1CrfSchema, H265CrfSchema, Vp9CrfSchema } from "./media-options.ts";

const SampleDurationSchema = Schema.Finite.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(3),
);
export const ComparisonSampleSchema = Schema.Struct({
  sampleId: IdentifierSchema,
  normalizedStartSeconds: NonNegativeFiniteSchema,
  actualSampleDurationSeconds: SampleDurationSchema,
});
export type ComparisonSample = typeof ComparisonSampleSchema.Type;

const SsimSchema = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const PsnrSchema = Schema.Union([PositiveFiniteSchema, Schema.Literal("infinite")]);

export const ComparisonMetricsSchema = Schema.Struct({
  ssim: SsimSchema,
  psnr: Schema.optionalKey(PsnrSchema),
});
export type ComparisonMetrics = typeof ComparisonMetricsSchema.Type;

const ComparisonVariantFields = {
  variantId: IdentifierSchema,
  previewArtifactId: IdentifierSchema,
  stillArtifactId: IdentifierSchema,
  sampleBytes: NonNegativeIntegerSchema,
  estimatedFullVideoBytes: NonNegativeIntegerSchema,
  estimateBasis: Schema.Literal("video-only-sample-bitrate-extrapolation"),
  metrics: ComparisonMetricsSchema,
  paretoOptimal: Schema.Boolean,
};

export const ComparisonVariantSchema = Schema.Union([
  Schema.Struct({
    codec: Schema.Literal("vp9"),
    crf: Vp9CrfSchema,
    ...ComparisonVariantFields,
  }),
  Schema.Struct({
    codec: Schema.Literal("h265"),
    crf: H265CrfSchema,
    ...ComparisonVariantFields,
  }),
  Schema.Struct({
    codec: Schema.Literal("av1"),
    crf: Av1CrfSchema,
    ...ComparisonVariantFields,
  }),
]);
export type ComparisonVariant = typeof ComparisonVariantSchema.Type;

const ComparisonConfidenceBasisSchema = Schema.Struct({
  sampleCount: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(5)),
  independentSampleCount: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(5)),
  temporalSpanRatio: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  sampledDurationRatio: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
}).check(
  Schema.makeFilter(({ sampleCount, independentSampleCount }) =>
    independentSampleCount > sampleCount
      ? "Independent samples cannot exceed requested samples"
      : undefined,
  ),
);

export const ComparisonDecisionSchema = Schema.Struct({
  basis: Schema.Literal("balanced-ssim-size"),
  recommendedVariantId: IdentifierSchema,
  paretoVariantIds: Schema.UniqueArray(IdentifierSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8),
  ),
  confidence: Schema.Literals(["low", "medium", "high"]),
  confidenceBasis: ComparisonConfidenceBasisSchema,
});
export type ComparisonDecision = typeof ComparisonDecisionSchema.Type;

export const CompareQualityResultSchema = Schema.Struct({
  kind: Schema.Literal("compare-quality"),
  samples: Schema.Array(ComparisonSampleSchema).check(Schema.isMinLength(1), Schema.isMaxLength(5)),
  variants: Schema.Array(ComparisonVariantSchema).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(8),
  ),
  decision: ComparisonDecisionSchema,
}).check(
  Schema.makeFilter(({ samples, variants, decision }) => {
    const sampleIds = samples.map(({ sampleId }) => sampleId);
    if (new Set(sampleIds).size !== sampleIds.length) return "Comparison sample IDs must be unique";

    const variantIds = variants.map(({ variantId }) => variantId);
    if (new Set(variantIds).size !== variantIds.length) {
      return "Comparison variant IDs must be unique";
    }
    if (!decision.paretoVariantIds.includes(decision.recommendedVariantId)) {
      return "The recommended comparison variant must be Pareto optimal";
    }
    if (!variantIds.includes(decision.recommendedVariantId)) {
      return "The recommended comparison variant must exist";
    }
    if (decision.paretoVariantIds.some((variantId) => !variantIds.includes(variantId))) {
      return "Every Pareto comparison variant must exist";
    }
    const optimalIds = variants
      .filter(({ paretoOptimal }) => paretoOptimal)
      .map(({ variantId }) => variantId);
    if (
      optimalIds.length !== decision.paretoVariantIds.length ||
      optimalIds.some((variantId) => !decision.paretoVariantIds.includes(variantId))
    ) {
      return "Pareto flags and the comparison decision must agree";
    }
    if (decision.confidenceBasis.sampleCount !== samples.length) {
      return "Comparison confidence sample count must match the result samples";
    }
  }),
);
export type CompareQualityResult = typeof CompareQualityResultSchema.Type;
