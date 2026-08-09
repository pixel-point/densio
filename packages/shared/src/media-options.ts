import { Schema } from "effect";

import {
  NonNegativeFiniteSchema,
  NonNegativeIntegerSchema,
  PositiveFiniteSchema,
  PositiveIntegerSchema,
} from "./common-contracts.ts";
import { MEDIA_CODEC_POLICY, MEDIA_CODECS } from "./media-policy.ts";

export const MediaCodecSchema = Schema.Literals(MEDIA_CODECS);
export type { MediaCodec } from "./media-policy.ts";

export const AudioModeSchema = Schema.Literals(["auto", "keep", "remove"]);
export type AudioMode = typeof AudioModeSchema.Type;

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
  codecs: Schema.optionalKey(
    Schema.UniqueArray(MediaCodecSchema).check(Schema.isMinLength(1), Schema.isMaxLength(3)),
  ),
  crf: Schema.optionalKey(CompressionCrfSchema),
  audio: Schema.optionalKey(AudioModeSchema),
  transform: Schema.optionalKey(TransformOptionsSchema),
});
export type CompressionOptions = typeof CompressionOptionsSchema.Type;

const SecondsPositionSchema = Schema.Struct({
  kind: Schema.Literal("seconds"),
  seconds: NonNegativeFiniteSchema,
});

const TimecodePositionSchema = Schema.Struct({
  kind: Schema.Literal("timecode"),
  timecode: Schema.String.check(Schema.isPattern(/^(?:\d{2}:)?[0-5]\d:[0-5]\d(?:\.\d{1,3})?$/)),
});

const FramePositionSchema = Schema.Struct({
  kind: Schema.Literal("frame"),
  frame: NonNegativeIntegerSchema,
});

export const ComparisonPositionSchema = Schema.Union([
  SecondsPositionSchema,
  TimecodePositionSchema,
  FramePositionSchema,
]);
export type ComparisonPosition = typeof ComparisonPositionSchema.Type;

const ComparisonCrfs = <A extends Schema.Top>(crf: A) =>
  Schema.UniqueArray(crf).check(Schema.isMinLength(2), Schema.isMaxLength(8));

const ComparisonFields = {
  durationSeconds: Schema.optionalKey(
    Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
  ),
  position: Schema.optionalKey(ComparisonPositionSchema),
  transform: Schema.optionalKey(TransformOptionsSchema),
};

export const CompareQualityOptionsSchema = Schema.Union([
  Schema.Struct({
    codec: Schema.Literal("vp9"),
    crfs: ComparisonCrfs(Vp9CrfSchema),
    ...ComparisonFields,
  }),
  Schema.Struct({
    codec: Schema.Literal("h265"),
    crfs: ComparisonCrfs(H265CrfSchema),
    ...ComparisonFields,
  }),
  Schema.Struct({
    codec: Schema.Literal("av1"),
    crfs: ComparisonCrfs(Av1CrfSchema),
    ...ComparisonFields,
  }),
]);
export type CompareQualityOptions = typeof CompareQualityOptionsSchema.Type;

export const ExtractImagesOptionsSchema = Schema.Struct({
  intervalSeconds: Schema.optionalKey(PositiveFiniteSchema),
  format: Schema.optionalKey(ImageFormatSchema),
  transform: Schema.optionalKey(TransformOptionsSchema),
});
export type ExtractImagesOptions = typeof ExtractImagesOptionsSchema.Type;
