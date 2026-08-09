import {
  DEFAULT_COMPRESSION_CODECS,
  MEDIA_CODEC_CAPABILITIES,
  PLAN_CATALOG,
  type Capabilities,
  type Plan,
} from "@densio/shared";

import type { AppConfig } from "./config.ts";
import type { MediaCapabilities } from "./media/inspection/media-capabilities.ts";

export const buildCapabilities = (
  config: AppConfig,
  media: MediaCapabilities,
  plan: Plan,
): Capabilities => ({
  apiVersion: "v1",
  codecs: MEDIA_CODEC_CAPABILITIES,
  defaults: {
    audio: "auto",
    comparisonDurationSeconds: 1,
    comparisonPositionSeconds: 0,
    compressionCodecs: DEFAULT_COMPRESSION_CODECS,
    extractionFormat: "jpeg",
    extractionIntervalSeconds: 1,
  },
  limits: {
    artifactRetentionSeconds: config.artifactTtlSeconds,
    maxComparisonCrfs: 8,
    maxComparisonDurationSeconds: config.maxComparisonSeconds,
    maxExtractionImages: config.maxExtractedImages,
    maxUploadBytes: Math.min(config.maxUploadBytes, PLAN_CATALOG[plan].maxUploadBytes),
    maxVideoDurationSeconds: 1_800,
  },
  options: {
    audioModes: ["auto", "keep", "remove"],
    comparisonCrfCount: { maximum: 8, minimum: 2 },
    comparisonDurationSeconds: {
      default: 1,
      maximum: config.maxComparisonSeconds,
      minimum: 1,
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
  workflows: ["compress", "extract-images", "compare-quality"],
});
