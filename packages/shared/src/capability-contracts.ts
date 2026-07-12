import { Schema } from "effect";

import {
  ApiVersionSchema,
  PlanSchema,
  PositiveFiniteSchema,
  PositiveIntegerSchema,
} from "./common-contracts.ts";
import { JobWorkflowSchema } from "./job-contracts.ts";
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
  codec: Schema.Literal("vp9"),
  container: Schema.Literal("webm"),
  minimumPlan: Schema.Literal("free"),
  defaultCrf: Vp9CrfSchema,
  crfRange: Schema.Struct({ minimum: Schema.Literal(0), maximum: Schema.Literal(63) }),
});

const H265CapabilitySchema = Schema.Struct({
  codec: Schema.Literal("h265"),
  container: Schema.Literal("mp4"),
  minimumPlan: Schema.Literal("free"),
  defaultCrf: H265CrfSchema,
  crfRange: Schema.Struct({ minimum: Schema.Literal(0), maximum: Schema.Literal(51) }),
});

const Av1CapabilitySchema = Schema.Struct({
  codec: Schema.Literal("av1"),
  container: Schema.Literal("webm"),
  minimumPlan: Schema.Literal("pro"),
  defaultCrf: Av1CrfSchema,
  crfRange: Schema.Struct({ minimum: Schema.Literal(0), maximum: Schema.Literal(63) }),
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
    maximum: Schema.Literal(3),
    default: Schema.Literal(1),
  }),
});
export type CapabilityOptions = typeof CapabilityOptionsSchema.Type;

export const CapabilityDefaultsSchema = Schema.Struct({
  compressionCodecs: Schema.Tuple([Schema.Literal("vp9"), Schema.Literal("h265")]),
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
