import { Schema } from "effect";

import {
  ApiVersionSchema,
  IdentifierSchema,
  PlanSchema,
  NonNegativeIntegerSchema,
  PositiveFiniteSchema,
  PositiveIntegerSchema,
} from "./common-contracts.ts";
import { JobWorkflowSchema } from "./job-contracts.ts";
import { DEFAULT_COMPRESSION_CODECS, MEDIA_CODEC_POLICY } from "./media-policy.ts";
import { Av1CrfSchema, H265CrfSchema, Vp9CrfSchema } from "./media-options.ts";
import {
  OrganizationNameSchema,
  OrganizationOperationSchema,
  OrganizationRoleSchema,
} from "./organization-contracts.ts";

export const PlanLimitsSchema = Schema.Struct({
  includedStorageBytes: Schema.optionalKey(NonNegativeIntegerSchema),
  maxVideoDurationSeconds: PositiveFiniteSchema,
  maxUploadBytes: PositiveIntegerSchema,
  maxExtractionImages: PositiveIntegerSchema,
  maxComparisonVariants: PositiveIntegerSchema,
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
  bitDepths: Schema.optionalKey(Schema.Tuple([Schema.Literal(8), Schema.Literal(10)])),
  trim: Schema.optionalKey(
    Schema.Struct({
      positionKinds: Schema.Tuple([
        Schema.Literal("frame"),
        Schema.Literal("seconds"),
        Schema.Literal("timecode"),
      ]),
      frameIndexBase: Schema.Literal(0),
      endExclusive: Schema.Literal(true),
      reencodes: Schema.Literal(true),
      compression: Schema.Literal(true),
    }),
  ),
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
  comparisonVariantCount: Schema.Struct({ minimum: Schema.Literal(2), maximum: Schema.Literal(8) }),
  comparisonSampleCount: Schema.Struct({
    minimum: Schema.Literal(1),
    maximum: Schema.Literal(5),
    default: Schema.Literal(3),
  }),
  comparisonMetrics: Schema.Tuple([Schema.Literal("ssim"), Schema.Literal("psnr")]),
  comparisonDurationSeconds: Schema.Struct({
    minimum: Schema.Literal(1),
    maximum: Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
    default: Schema.Literal(1),
  }),
});
export type CapabilityOptions = typeof CapabilityOptionsSchema.Type;

export const CapabilityDefaultsSchema = Schema.Struct({
  bitDepth: Schema.optionalKey(Schema.Literal(8)),
  compressionCodecs: Schema.Tuple([
    Schema.Literal(DEFAULT_COMPRESSION_CODECS[0]),
    Schema.Literal(DEFAULT_COMPRESSION_CODECS[1]),
  ]),
  audio: Schema.Literal("auto"),
  extractionIntervalSeconds: Schema.Literal(1),
  extractionFormat: Schema.Literal("jpeg"),
  comparisonDurationSeconds: Schema.Literal(1),
  comparisonSamples: Schema.Literal(3),
  comparisonMetrics: Schema.Tuple([Schema.Literal("ssim")]),
});
export type CapabilityDefaults = typeof CapabilityDefaultsSchema.Type;

export const AgentControlPlaneCapabilitiesSchema = Schema.Struct({
  preparedSources: Schema.Literal(true),
  sourceListing: Schema.Literal(true),
  executionPlans: Schema.Literal(true),
  directJobSubmission: Schema.optionalKey(Schema.Literal(true)),
  jobEvents: Schema.Literal(true),
  stableArtifacts: Schema.Literal(true),
  sourceRetentionSeconds: PositiveIntegerSchema,
  planTtlSeconds: PositiveIntegerSchema,
  artifactAccessGrantTtlSeconds: PositiveIntegerSchema,
});
export type AgentControlPlaneCapabilities = typeof AgentControlPlaneCapabilitiesSchema.Type;

const CommonCapabilityFields = {
  hls: Schema.optionalKey(
    Schema.Struct({
      codecs: Schema.Tuple([Schema.Literal("h265")]),
      profileVersion: Schema.Literal("hevc-vod-1"),
      maximumRenditions: Schema.Literal(3),
      maximumMembers: Schema.Literal(20000),
      container: Schema.Literal("fmp4"),
      defaultCrf: H265CrfSchema,
      defaultRateControl: Schema.Literal("capped-crf"),
      privatePlayback: Schema.Literal(false),
    }),
  ),
  storage: Schema.optionalKey(
    Schema.Struct({
      customerStorage: Schema.Literal(true),
      customerStorageConfigured: Schema.Boolean,
      managedStorageConfigured: Schema.Boolean,
      publicByDefault: Schema.Literal(true),
      directSourceUploads: Schema.Boolean,
      maxSourceSessions: Schema.Literal(4),
      multipartPartBytes: Schema.Literal(67_108_864),
    }),
  ),
  apiVersion: ApiVersionSchema,
  workflows: Schema.UniqueArray(JobWorkflowSchema).check(Schema.isMinLength(1)),
  codecs: Schema.UniqueArray(CodecCapabilitySchema).check(Schema.isMinLength(1)),
  options: CapabilityOptionsSchema,
  defaults: CapabilityDefaultsSchema,
  controlPlane: AgentControlPlaneCapabilitiesSchema,
  server: Schema.Struct({
    maxConcurrentMediaProcesses: PositiveIntegerSchema,
    ffmpegVersion: Schema.NonEmptyString,
    ffprobeVersion: Schema.NonEmptyString,
  }),
};
export const CapabilitiesSchema = Schema.Struct({
  ...CommonCapabilityFields,
  scope: Schema.Literal("organization"),
  organizationId: IdentifierSchema,
  organizationName: OrganizationNameSchema,
  role: OrganizationRoleSchema,
  actions: Schema.UniqueArray(OrganizationOperationSchema),
  plan: PlanSchema,
  limits: PlanLimitsSchema,
});
export type Capabilities = typeof CapabilitiesSchema.Type;
export const PublicCapabilitiesSchema = Schema.Struct({
  ...CommonCapabilityFields,
  scope: Schema.Literal("public"),
  plans: Schema.Array(
    Schema.Struct({
      plan: PlanSchema,
      monthlyCredits: PositiveIntegerSchema,
      limits: PlanLimitsSchema,
    }),
  ).check(Schema.isMinLength(1)),
});
export type PublicCapabilities = typeof PublicCapabilitiesSchema.Type;
