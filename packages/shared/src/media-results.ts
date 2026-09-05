import { HlsResultSchema } from "./hls-contracts.ts";
import { Schema } from "effect";
import {
  IdentifierSchema,
  PositiveFiniteSchema,
  PositiveIntegerSchema,
} from "./common-contracts.ts";
import { CompareQualityResultSchema } from "./quality-comparison-results.ts";

export const CompressionResultSchema = Schema.Struct({
  kind: Schema.Literal("compress"),
  artifactIds: Schema.UniqueArray(IdentifierSchema).check(Schema.isMinLength(1)),
  html: Schema.NonEmptyString,
});
export type CompressionResult = typeof CompressionResultSchema.Type;

export const ExtractImagesResultSchema = Schema.Struct({
  kind: Schema.Literal("extract-images"),
  archiveArtifactId: IdentifierSchema,
  imageCount: PositiveIntegerSchema,
  intervalSeconds: PositiveFiniteSchema,
});
export type ExtractImagesResult = typeof ExtractImagesResultSchema.Type;

export const TrimResultSchema = Schema.Struct({
  kind: Schema.Literal("trim"),
  artifactIds: Schema.Array(IdentifierSchema).check(Schema.isLengthBetween(1, 1)),
});
export type TrimResult = typeof TrimResultSchema.Type;

export const JobResultSchema = Schema.Union([
  TrimResultSchema,
  HlsResultSchema,
  CompressionResultSchema,
  ExtractImagesResultSchema,
  CompareQualityResultSchema,
]);
export type JobResult = typeof JobResultSchema.Type;
