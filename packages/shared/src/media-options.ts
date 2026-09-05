import { TrimRangeSchema, ResolvedTrimRangeSchema } from "./trim-range.ts";
import { Schema } from "effect";

import {
  NonNegativeIntegerSchema,
  PositiveFiniteSchema,
  PositiveIntegerSchema,
} from "./common-contracts.ts";
import { MEDIA_CODEC_POLICY, MEDIA_CODECS } from "./media-policy.ts";

export const MediaCodecSchema = Schema.Literals(MEDIA_CODECS);
export type { MediaCodec } from "./media-policy.ts";

export const AudioModeSchema = Schema.Literals(["auto", "keep", "remove"]);
export type AudioMode = typeof AudioModeSchema.Type;

export const MediaBitDepthSchema = Schema.Literals([8, 10]).annotate({
  description:
    "Output bit depth for compression or quality comparison. Defaults to 8; 10-bit video is verified before publication.",
});
export type MediaBitDepth = typeof MediaBitDepthSchema.Type;

export const FrameRatePolicySchema = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("preserve") }),
  Schema.Struct({ maximum: Schema.Literal(30), mode: Schema.Literal("cap") }),
]);
export type FrameRatePolicy = typeof FrameRatePolicySchema.Type;

export const ImageFormatSchema = Schema.Literals(["jpeg", "png", "webp"]);
export type ImageFormat = typeof ImageFormatSchema.Type;

export const Vp9CrfSchema = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween(MEDIA_CODEC_POLICY.vp9.crfRange),
);
export type Vp9Crf = typeof Vp9CrfSchema.Type;

export const H265CrfSchema = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween(MEDIA_CODEC_POLICY.h265.crfRange),
);
export type H265Crf = typeof H265CrfSchema.Type;

export const Av1CrfSchema = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween(MEDIA_CODEC_POLICY.av1.crfRange),
);
export type Av1Crf = typeof Av1CrfSchema.Type;

const WidthScaleSchema = Schema.Struct({
  width: PositiveIntegerSchema,
  allowUpscale: Schema.optionalKey(Schema.Boolean),
});

const HeightScaleSchema = Schema.Struct({
  height: PositiveIntegerSchema,
  allowUpscale: Schema.optionalKey(Schema.Boolean),
});

export const ScaleOptionsSchema = Schema.Union([WidthScaleSchema, HeightScaleSchema], {
  mode: "oneOf",
});
export type ScaleOptions = typeof ScaleOptionsSchema.Type;

const AspectRatioCropSchema = Schema.Struct({
  kind: Schema.Literal("aspect-ratio"),
  aspectRatio: Schema.String.check(Schema.isPattern(/^[1-9]\d*:[1-9]\d*$/)),
});

const RectangleCropSchema = Schema.Struct({
  kind: Schema.Literal("rectangle"),
  width: PositiveIntegerSchema,
  height: PositiveIntegerSchema,
  x: NonNegativeIntegerSchema,
  y: NonNegativeIntegerSchema,
});

export const CropOptionsSchema = Schema.Union([AspectRatioCropSchema, RectangleCropSchema]);
export type CropOptions = typeof CropOptionsSchema.Type;

export const TransformOptionsSchema = Schema.Struct({
  crop: Schema.optionalKey(CropOptionsSchema),
  scale: Schema.optionalKey(ScaleOptionsSchema),
});
export type TransformOptions = typeof TransformOptionsSchema.Type;

const CompressionCrfSchema = Schema.Struct({
  vp9: Schema.optionalKey(Vp9CrfSchema),
  h265: Schema.optionalKey(H265CrfSchema),
  av1: Schema.optionalKey(Av1CrfSchema),
});

export const CompressionOptionsSchema = Schema.Struct({
  bitDepth: Schema.optionalKey(MediaBitDepthSchema),
  trim: Schema.optionalKey(TrimRangeSchema),
  codecs: Schema.optionalKey(
    Schema.UniqueArray(MediaCodecSchema).check(Schema.isMinLength(1), Schema.isMaxLength(3)),
  ),
  crf: Schema.optionalKey(CompressionCrfSchema),
  audio: Schema.optionalKey(AudioModeSchema),
  frameRate: Schema.optionalKey(FrameRatePolicySchema),
  transform: Schema.optionalKey(TransformOptionsSchema),
});
export type CompressionOptions = typeof CompressionOptionsSchema.Type;

export const ResolvedCompressionOptionsSchema = Schema.Struct({
  // Older immutable plan snapshots omit bit depth and retain their 8-bit behavior.
  bitDepth: Schema.optionalKey(MediaBitDepthSchema),
  trim: Schema.optionalKey(ResolvedTrimRangeSchema),
  codecs: Schema.UniqueArray(MediaCodecSchema).check(Schema.isMinLength(1), Schema.isMaxLength(3)),
  crf: CompressionCrfSchema,
  audio: AudioModeSchema,
  frameRate: FrameRatePolicySchema,
  transform: Schema.optionalKey(TransformOptionsSchema),
}).check(
  Schema.makeFilter(({ codecs, crf }) => {
    if (codecs.some((codec) => crf[codec] === undefined))
      return "Every selected codec must have a resolved CRF";
  }),
);
export type ResolvedCompressionOptions = typeof ResolvedCompressionOptionsSchema.Type;

export const ExtractImagesOptionsSchema = Schema.Struct({
  intervalSeconds: Schema.optionalKey(PositiveFiniteSchema),
  format: Schema.optionalKey(ImageFormatSchema),
  transform: Schema.optionalKey(TransformOptionsSchema),
});
export type ExtractImagesOptions = typeof ExtractImagesOptionsSchema.Type;

export const ResolvedExtractImagesOptionsSchema = Schema.Struct({
  intervalSeconds: PositiveFiniteSchema,
  format: ImageFormatSchema,
  transform: Schema.optionalKey(TransformOptionsSchema),
  outputDimensions: Schema.Struct({
    width: PositiveIntegerSchema,
    height: PositiveIntegerSchema,
  }),
});
export type ResolvedExtractImagesOptions = typeof ResolvedExtractImagesOptionsSchema.Type;
