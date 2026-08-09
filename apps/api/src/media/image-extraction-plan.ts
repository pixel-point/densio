import type { ImageFormat } from "@densio/shared";

import { assertCommandPath, createCommandPlan } from "./command-plan.ts";
import { formatNumber } from "./compression-plan.ts";
import { MediaPlanError } from "./media-plan-error.ts";
import { buildVideoFilters, type TransformOptions, type VideoDimensions } from "./video-filter.ts";

export type { ImageFormat } from "@densio/shared";

export interface ImageExtractionPlanOptions {
  readonly executable?: string;
  readonly inputPath: string;
  readonly outputPattern: string;
  readonly source: VideoDimensions;
  readonly intervalSeconds?: number;
  readonly format?: ImageFormat;
  readonly transform?: TransformOptions;
}

export const buildImageExtractionPlan = (options: ImageExtractionPlanOptions) => {
  assertCommandPath(options.inputPath, "Input");
  assertCommandPath(options.outputPattern, "Output");
  const intervalSeconds = options.intervalSeconds ?? 1;
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    throw new MediaPlanError("INVALID_INTERVAL", "Extraction interval must be positive and finite");
  }

  const filters = [
    ...buildVideoFilters(options.source, options.transform),
    `fps=1/${formatNumber(intervalSeconds)}`,
  ];
  const argv = [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    options.inputPath,
    "-map",
    "0:v:0",
    "-vf",
    filters.join(","),
    "-fps_mode",
    "vfr",
    ...imageEncoderArguments(options.format ?? "jpeg"),
    options.outputPattern,
  ];

  return createCommandPlan(options.executable ?? "ffmpeg", argv);
};

const imageEncoderArguments = (format: ImageFormat) => {
  if (format === "jpeg") return ["-c:v", "mjpeg", "-q:v", "2"];
  if (format === "png") return ["-c:v", "png"];
  if (format === "webp") return ["-c:v", "libwebp", "-quality", "90"];

  throw new MediaPlanError("INVALID_IMAGE_FORMAT", "Image format is invalid");
};
