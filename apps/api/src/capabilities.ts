import type { Capabilities, Plan } from "@ffmpeg-api/shared";

import type { AppConfig } from "./config.ts";
import type { MediaCapabilities } from "./media/inspection/media-capabilities.ts";

export const buildCapabilities = (
  config: AppConfig,
  media: MediaCapabilities,
  plan: Plan,
): Capabilities => ({
  apiVersion: "v1",
  codecs: [
    {
      codec: "vp9",
      container: "webm",
      crfRange: { maximum: 63, minimum: 0 },
      defaultCrf: 40,
      minimumPlan: "free",
    },
    {
      codec: "h265",
      container: "mp4",
      crfRange: { maximum: 51, minimum: 0 },
      defaultCrf: 32,
      minimumPlan: "free",
    },
    {
      codec: "av1",
      container: "webm",
      crfRange: { maximum: 63, minimum: 0 },
      defaultCrf: 35,
      minimumPlan: "pro",
    },
  ],
  defaults: {
    audio: "auto",
    comparisonDurationSeconds: 1,
    comparisonPositionSeconds: 0,
    compressionCodecs: ["vp9", "h265"],
    extractionFormat: "jpeg",
    extractionIntervalSeconds: 1,
  },
  limits: {
    artifactRetentionSeconds: config.artifactTtlSeconds,
    maxComparisonCrfs: 8,
    maxComparisonDurationSeconds: config.maxComparisonSeconds,
    maxExtractionImages: config.maxExtractedImages,
    maxUploadBytes: config.maxUploadBytes,
    maxVideoDurationSeconds: plan === "pro" ? 1_800 : 10,
  },
  options: {
    audioModes: ["auto", "keep", "remove"],
    comparisonCrfCount: { maximum: 8, minimum: 2 },
    comparisonDurationSeconds: { default: 1, maximum: 3, minimum: 1 },
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
