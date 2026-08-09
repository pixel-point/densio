import { Schema } from "effect";

import {
  ApiVersionSchema,
  PlanSchema,
  PositiveFiniteSchema,
  PositiveIntegerSchema,
} from "./common-contracts.ts";
import { JobWorkflowSchema } from "./job-contracts.ts";
import { DEFAULT_COMPRESSION_CODECS, MEDIA_CODEC_POLICY } from "./media-policy.ts";
import { Av1CrfSchema, H265CrfSchema, Vp9CrfSchema } from "./media-options.ts";

export const PlanLimitsSchema = Schema.Struct({
  maxVideoDurationSeconds: PositiveFiniteSchema,
  maxUploadBytes: PositiveIntegerSchema,
  maxExtractionImages: PositiveIntegerSchema,
  maxComparisonCrfs: PositiveIntegerSchema,
  maxComparisonDurationSeconds: PositiveFiniteSchema,
  artifactRetentionSeconds: PositiveIntegerSchema,
});
export type PlanLimits = typeof PlanLimitsSchema.Type;

const Vp9CapabilitySchema = Schema.Struct({
  codec: Schema.Literal(MEDIA_CODEC_POLICY.vp9.codec),
  container: Schema.Literal(MEDIA_CODEC_POLICY.vp9.container),
  minimumPlan: Schema.Literal(MEDIA_CODEC_POLICY.vp9.minimumPlan),
  defaultCrf: Vp9CrfSchema,
  crfRange: Schema.Struct({
    minimum: Schema.Literal(MEDIA_CODEC_POLICY.vp9.crfRange.minimum),
    maximum: Schema.Literal(MEDIA_CODEC_POLICY.vp9.crfRange.maximum),
  }),
});

const H265CapabilitySchema = Schema.Struct({
  codec: Schema.Literal(MEDIA_CODEC_POLICY.h265.codec),
  container: Schema.Literal(MEDIA_CODEC_POLICY.h265.container),
  minimumPlan: Schema.Literal(MEDIA_CODEC_POLICY.h265.minimumPlan),
  defaultCrf: H265CrfSchema,
  crfRange: Schema.Struct({
    minimum: Schema.Literal(MEDIA_CODEC_POLICY.h265.crfRange.minimum),
    maximum: Schema.Literal(MEDIA_CODEC_POLICY.h265.crfRange.maximum),
  }),
});

const Av1CapabilitySchema = Schema.Struct({
  codec: Schema.Literal(MEDIA_CODEC_POLICY.av1.codec),
  container: Schema.Literal(MEDIA_CODEC_POLICY.av1.container),
  minimumPlan: Schema.Literal(MEDIA_CODEC_POLICY.av1.minimumPlan),
  defaultCrf: Av1CrfSchema,
  crfRange: Schema.Struct({
    minimum: Schema.Literal(MEDIA_CODEC_POLICY.av1.crfRange.minimum),
    maximum: Schema.Literal(MEDIA_CODEC_POLICY.av1.crfRange.maximum),
  }),
});

export const CodecCapabilitySchema = Schema.Union([
  Vp9CapabilitySchema,
  H265CapabilitySchema,
  Av1CapabilitySchema,
]);
export type CodecCapability = typeof CodecCapabilitySchema.Type;

export const CapabilityOptionsSchema = Schema.Struct({
  audioModes: Schema.Tuple([
    Schema.Literal("auto"),
    Schema.Literal("keep"),
    Schema.Literal("remove"),
  ]),
  imageFormats: Schema.Tuple([
    Schema.Literal("jpeg"),
    Schema.Literal("png"),
    Schema.Literal("webp"),
  ]),
  cropKinds: Schema.Tuple([Schema.Literal("aspect-ratio"), Schema.Literal("rectangle")]),
  scaleDimensions: Schema.Tuple([Schema.Literal("width"), Schema.Literal("height")]),
  comparisonPositionKinds: Schema.Tuple([
    Schema.Literal("seconds"),
    Schema.Literal("timecode"),
    Schema.Literal("frame"),
  ]),
  comparisonCrfCount: Schema.Struct({ minimum: Schema.Literal(2), maximum: Schema.Literal(8) }),
  comparisonDurationSeconds: Schema.Struct({
    minimum: Schema.Literal(1),
    maximum: Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
    default: Schema.Literal(1),
  }),
});
export type CapabilityOptions = typeof CapabilityOptionsSchema.Type;

export const CapabilityDefaultsSchema = Schema.Struct({
  compressionCodecs: Schema.Tuple([
    Schema.Literal(DEFAULT_COMPRESSION_CODECS[0]),
    Schema.Literal(DEFAULT_COMPRESSION_CODECS[1]),
  ]),
  audio: Schema.Literal("auto"),
  extractionIntervalSeconds: Schema.Literal(1),
  extractionFormat: Schema.Literal("jpeg"),
  comparisonDurationSeconds: Schema.Literal(1),
  comparisonPositionSeconds: Schema.Literal(0),
});
export type CapabilityDefaults = typeof CapabilityDefaultsSchema.Type;

export const CapabilitiesSchema = Schema.Struct({
  apiVersion: ApiVersionSchema,
  workflows: Schema.UniqueArray(JobWorkflowSchema).check(Schema.isMinLength(1)),
  plan: PlanSchema,
  limits: PlanLimitsSchema,
  codecs: Schema.UniqueArray(CodecCapabilitySchema).check(Schema.isMinLength(1)),
  options: CapabilityOptionsSchema,
  defaults: CapabilityDefaultsSchema,
  server: Schema.Struct({
    maxConcurrentMediaProcesses: PositiveIntegerSchema,
    ffmpegVersion: Schema.NonEmptyString,
    ffprobeVersion: Schema.NonEmptyString,
  }),
});
export type Capabilities = typeof CapabilitiesSchema.Type;
