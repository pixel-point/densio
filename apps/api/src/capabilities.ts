import {
  DEFAULT_COMPRESSION_CODECS,
  MEDIA_CODEC_CAPABILITIES,
  MEDIA_CODEC_POLICY,
  PLAN_CATALOG,
  type PublicCapabilities,
  type Capabilities,
  type Plan,
} from "@densio/shared";

import type { AppConfig } from "./config.ts";
import type { MediaCapabilities } from "./media/inspection/media-capabilities.ts";

export const buildCapabilities = (
  config: AppConfig,
  media: MediaCapabilities,
  plan: Plan,
): Omit<Capabilities, "scope" | "organizationId" | "organizationName" | "role" | "actions"> => ({
  apiVersion: "v1",
  hls: {
    codecs: ["h265"],
    profileVersion: "hevc-vod-1",
    maximumRenditions: 3,
    maximumMembers: 20000,
    container: "fmp4",
    defaultCrf: MEDIA_CODEC_POLICY.h265.defaultCrf,
    defaultRateControl: "capped-crf",
    privatePlayback: false,
  },
  storage: {
    customerStorage: true as const,
    customerStorageConfigured: Boolean(config.storage.activeCredentialKey),
    managedStorageConfigured: Boolean(config.storage.activeManagedTarget),
    publicByDefault: true,
    directSourceUploads: Boolean(config.storage.activeCredentialKey),
    maxSourceSessions: 4,
    multipartPartBytes: 67_108_864,
  },
  codecs: MEDIA_CODEC_CAPABILITIES,
  controlPlane: {
    artifactAccessGrantTtlSeconds: config.artifactAccessGrantTtlSeconds,
    executionPlans: true,
    directJobSubmission: true,
    jobEvents: true,
    planTtlSeconds: config.planTtlSeconds,
    preparedSources: true,
    sourceListing: true,
    sourceRetentionSeconds: config.sourceTtlSeconds,
    stableArtifacts: true,
  },
  defaults: {
    bitDepth: 8,
    audio: "auto",
    comparisonDurationSeconds: 1,
    comparisonSamples: 3,
    comparisonMetrics: ["ssim"],
    compressionCodecs: DEFAULT_COMPRESSION_CODECS,
    extractionFormat: "jpeg",
    extractionIntervalSeconds: 1,
  },
  limits: {
    includedStorageBytes: PLAN_CATALOG[plan].includedStorageBytes,
    artifactRetentionSeconds: config.artifactTtlSeconds,
    maxComparisonVariants: 8,
    maxComparisonDurationSeconds: config.maxComparisonSeconds,
    maxExtractionImages: config.maxExtractedImages,
    maxUploadBytes: Math.min(config.maxUploadBytes, PLAN_CATALOG[plan].maxUploadBytes),
    maxVideoDurationSeconds: PLAN_CATALOG[plan].maxVideoDurationSeconds,
  },
  options: {
    bitDepths: [8, 10],
    audioModes: ["auto", "keep", "remove"],
    comparisonMetrics: ["ssim", "psnr"],
    comparisonSampleCount: { default: 3, maximum: 5, minimum: 1 },
    comparisonVariantCount: { maximum: 8, minimum: 2 },
    comparisonDurationSeconds: {
      default: 1,
      maximum: config.maxComparisonSeconds,
      minimum: 1,
    },
    trim: {
      positionKinds: ["frame", "seconds", "timecode"],
      frameIndexBase: 0,
      endExclusive: true,
      reencodes: true,
      compression: true,
    },
    comparisonPositionKinds: ["seconds", "timecode", "frame"],
    cropKinds: ["aspect-ratio", "rectangle"],
    imageFormats: ["jpeg", "png", "webp"],
    scaleDimensions: ["width", "height"],
  },
  plan,
  server: {
    ffmpegVersion: media.ffmpegVersion,
    ffprobeVersion: media.ffprobeVersion,
    maxConcurrentMediaProcesses: config.maxConcurrentMediaProcesses,
  },
  workflows: ["compress", "extract-images", "compare-quality", "hls", "trim"],
});

export const buildPublicCapabilities = (
  config: AppConfig,
  media: MediaCapabilities,
): PublicCapabilities => {
  const { plan: _, limits: __, ...common } = buildCapabilities(config, media, "free");
  return {
    ...common,
    scope: "public",
    plans: (["free", "basic", "pro", "scale"] as const).map((plan) => ({
      plan,
      monthlyCredits: PLAN_CATALOG[plan].monthlyCredits,
      limits: buildCapabilities(config, media, plan).limits,
    })),
  };
};
