import { Schema } from "effect";

import { ArtifactMetadataSchema, MediaCommandSchema } from "./artifact-contracts.ts";
import {
  NonNegativeFiniteSchema,
  NonNegativeIntegerSchema,
  PositiveFiniteSchema,
  PositiveIntegerSchema,
} from "./common-contracts.ts";
import { Av1CrfSchema, H265CrfSchema, MediaCodecSchema, Vp9CrfSchema } from "./media-options.ts";

const ArtifactsSchema = Schema.Array(ArtifactMetadataSchema).check(Schema.isMinLength(1));
const CommandsSchema = Schema.Array(MediaCommandSchema).check(Schema.isMinLength(1));

export const CompressionResultSchema = Schema.Struct({
  kind: Schema.Literal("compress"),
  artifacts: ArtifactsSchema,
  html: Schema.NonEmptyString,
  commands: CommandsSchema,
});
export type CompressionResult = typeof CompressionResultSchema.Type;

const ImageArchiveArtifactSchema = Schema.Struct({
  ...ArtifactMetadataSchema.fields,
  kind: Schema.Literal("image-archive"),
});

export const ExtractImagesResultSchema = Schema.Struct({
  kind: Schema.Literal("extract-images"),
  archive: ImageArchiveArtifactSchema,
  imageCount: PositiveIntegerSchema,
  intervalSeconds: PositiveFiniteSchema,
  commands: CommandsSchema,
});
export type ExtractImagesResult = typeof ExtractImagesResultSchema.Type;

const PreviewVideoArtifactSchema = Schema.Struct({
  ...ArtifactMetadataSchema.fields,
  kind: Schema.Literal("preview-video"),
});

const PreviewImageArtifactSchema = Schema.Struct({
  ...ArtifactMetadataSchema.fields,
  kind: Schema.Literal("preview-image"),
});

export const ComparisonVariantSchema = Schema.Struct({
  crf: Schema.Union([Vp9CrfSchema, H265CrfSchema, Av1CrfSchema]),
  preview: PreviewVideoArtifactSchema,
  still: PreviewImageArtifactSchema,
  sampleBytes: NonNegativeIntegerSchema,
  estimatedFullVideoBytes: NonNegativeIntegerSchema,
  estimateBasis: Schema.Literal("sample-bitrate-extrapolation"),
});
export type ComparisonVariant = typeof ComparisonVariantSchema.Type;

export const CompareQualityResultSchema = Schema.Struct({
  kind: Schema.Literal("compare-quality"),
  codec: MediaCodecSchema,
  normalizedStartSeconds: NonNegativeFiniteSchema,
  actualSampleDurationSeconds: Schema.Finite.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(3),
  ),
  variants: Schema.Array(ComparisonVariantSchema).check(Schema.isMinLength(1)),
  commands: CommandsSchema,
});
export type CompareQualityResult = typeof CompareQualityResultSchema.Type;

export const JobResultSchema = Schema.Union([
  CompressionResultSchema,
  ExtractImagesResultSchema,
  CompareQualityResultSchema,
]);
export type JobResult = typeof JobResultSchema.Type;
