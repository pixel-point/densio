import type { ComparisonPosition } from "@ffmpeg-api/shared";

import { assertCommandPath, createCommandPlan, type CommandPlan } from "./command-plan.ts";
import {
  assertCrf,
  buildCompressionPlan,
  formatNumber,
  type AudioAnalysis,
  type AudioMode,
  type MediaCodec,
} from "./compression-plan.ts";
import { MediaPlanError } from "./media-plan-error.ts";
import type { TransformOptions, VideoDimensions } from "./video-filter.ts";

export type { ComparisonPosition } from "@ffmpeg-api/shared";

interface ComparisonOutputPaths {
  readonly preview: string;
  readonly still: string;
}

export interface QualityComparisonPlanOptions {
  readonly executable?: string;
  readonly codec: MediaCodec;
  readonly crfs: readonly number[];
  readonly inputPath: string;
  readonly outputPaths: readonly ComparisonOutputPaths[];
  readonly source: VideoDimensions;
  readonly sourceDurationSeconds?: number;
  readonly durationSeconds?: number;
  readonly position?: ComparisonPosition;
  readonly resolvedFrameTimestampSeconds?: number;
  readonly audio?: AudioMode;
  readonly audioAnalysis?: AudioAnalysis;
  readonly transform?: TransformOptions;
}

export interface QualityComparisonVariantPlan {
  readonly codec: MediaCodec;
  readonly crf: number;
  readonly startSeconds: number;
  readonly durationSeconds: number;
  readonly sourceFrame?: number;
  readonly preview: CommandPlan;
  readonly representativeFrame: CommandPlan;
}

interface EstimateFullVideoBytesOptions {
  readonly sampleBytes: number;
  readonly sampleDurationSeconds: number;
  readonly sourceDurationSeconds: number;
}

export const buildQualityComparisonPlans = (options: QualityComparisonPlanOptions) => {
  const durationSeconds = options.durationSeconds ?? 1;
  assertSampleDuration(durationSeconds);
  assertComparisonCrfs(options.codec, options.crfs);
  if (options.outputPaths.length !== options.crfs.length) {
    throw new MediaPlanError(
      "OUTPUT_PATH_COUNT_MISMATCH",
      "An output path pair is required for every CRF",
    );
  }

  const position = normalizePosition(options.position, options.resolvedFrameTimestampSeconds);
  const actualDurationSeconds = resolveActualDuration(
    durationSeconds,
    position.seconds,
    options.sourceDurationSeconds,
  );

  return options.crfs.map((crf, index): QualityComparisonVariantPlan => {
    const outputPaths = options.outputPaths[index];
    if (outputPaths === undefined) {
      throw new MediaPlanError("OUTPUT_PATH_COUNT_MISMATCH", "Comparison output path is missing");
    }

    return {
      codec: options.codec,
      crf,
      startSeconds: position.seconds,
      durationSeconds: actualDurationSeconds,
      ...(position.frame === undefined ? {} : { sourceFrame: position.frame }),
      preview: buildCompressionPlan({
        executable: options.executable ?? "ffmpeg",
        codec: options.codec,
        crf,
        inputPath: options.inputPath,
        outputPath: outputPaths.preview,
        source: options.source,
        audio: options.audio ?? "auto",
        ...(options.audioAnalysis === undefined ? {} : { audioAnalysis: options.audioAnalysis }),
        ...(options.transform === undefined ? {} : { transform: options.transform }),
        segment: { startSeconds: position.seconds, durationSeconds: actualDurationSeconds },
      }),
      representativeFrame: buildRepresentativeFramePlan(
        options.executable ?? "ffmpeg",
        outputPaths,
        actualDurationSeconds,
      ),
    };
  });
};

export const estimateFullVideoBytes = (options: EstimateFullVideoBytesOptions) => {
  if (!Number.isSafeInteger(options.sampleBytes) || options.sampleBytes < 0) {
    throw new MediaPlanError("INVALID_SAMPLE_BYTES", "Sample bytes must be a non-negative integer");
  }
  assertPositiveFinite(options.sampleDurationSeconds, "Sample duration");
  assertPositiveFinite(options.sourceDurationSeconds, "Source duration");
  const estimate = Math.ceil(
    (options.sampleBytes * options.sourceDurationSeconds) / options.sampleDurationSeconds,
  );
  if (!Number.isSafeInteger(estimate)) {
    throw new MediaPlanError("INVALID_SIZE_ESTIMATE", "Full-video size estimate is too large");
  }

  return estimate;
};

const buildRepresentativeFramePlan = (
  executable: string,
  paths: ComparisonOutputPaths,
  durationSeconds: number,
) => {
  assertCommandPath(paths.preview, "Preview");
  assertCommandPath(paths.still, "Still");

  return createCommandPlan(executable, [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    paths.preview,
    "-ss",
    formatNumber(durationSeconds / 2),
    "-frames:v",
    "1",
    "-c:v",
    "mjpeg",
    "-q:v",
    "2",
    paths.still,
  ]);
};

const assertComparisonCrfs = (codec: MediaCodec, crfs: readonly number[]) => {
  if (!Array.isArray(crfs) || crfs.length < 2 || crfs.length > 8) {
    throw new MediaPlanError("INVALID_COMPARISON_CRFS", "Comparison requires 2 to 8 CRFs");
  }
  if (new Set(crfs).size !== crfs.length) {
    throw new MediaPlanError("DUPLICATE_COMPARISON_CRF", "Comparison CRFs must be unique");
  }
  crfs.forEach((crf) => assertCrf(codec, crf));
};

const normalizePosition = (
  position: ComparisonPosition | undefined,
  resolvedFrameTimestampSeconds: number | undefined,
) => {
  if (position === undefined) return { seconds: 0 };
  if (position.kind === "seconds") {
    assertNonNegativeFinite(position.seconds, "Comparison position");
    return { seconds: position.seconds };
  }
  if (position.kind === "timecode") return { seconds: parseTimecode(position.timecode) };
  if (position.kind !== "frame" || !Number.isSafeInteger(position.frame) || position.frame < 0) {
    throw new MediaPlanError("INVALID_COMPARISON_POSITION", "Comparison frame is invalid");
  }
  if (resolvedFrameTimestampSeconds === undefined) {
    throw new MediaPlanError(
      "FRAME_TIMESTAMP_REQUIRED",
      "A probe-resolved frame timestamp is required",
    );
  }
  assertNonNegativeFinite(resolvedFrameTimestampSeconds, "Resolved frame timestamp");

  return { seconds: resolvedFrameTimestampSeconds, frame: position.frame };
};

const parseTimecode = (timecode: string) => {
  const match =
    typeof timecode === "string"
      ? /^(?:(\d{2}):)?([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?$/.exec(timecode)
      : null;
  if (match === null) {
    throw new MediaPlanError("INVALID_TIMECODE", "Comparison timecode is invalid");
  }

  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number((match[4] ?? "").padEnd(3, "0"));
  const result = hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
  assertNonNegativeFinite(result, "Comparison timecode");

  return result;
};

const assertSampleDuration = (durationSeconds: number) => {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 3) {
    throw new MediaPlanError(
      "INVALID_SAMPLE_DURATION",
      "Sample duration must be from 1 to 3 seconds",
    );
  }
};

const resolveActualDuration = (
  requestedDurationSeconds: number,
  startSeconds: number,
  sourceDurationSeconds: number | undefined,
) => {
  if (sourceDurationSeconds === undefined) return requestedDurationSeconds;
  if (!Number.isFinite(sourceDurationSeconds) || sourceDurationSeconds <= 0) {
    throw new MediaPlanError("INVALID_SOURCE_DURATION", "Source duration must be positive");
  }
  const actualDurationSeconds = Math.min(
    requestedDurationSeconds,
    sourceDurationSeconds - startSeconds,
  );
  if (actualDurationSeconds <= 0) {
    throw new MediaPlanError(
      "INVALID_COMPARISON_POSITION",
      "Comparison position must be before the source end",
    );
  }
  return actualDurationSeconds;
};

const assertNonNegativeFinite = (value: number, label: string) => {
  if (!Number.isFinite(value) || value < 0) {
    throw new MediaPlanError("INVALID_COMPARISON_POSITION", `${label} is invalid`);
  }
};

const assertPositiveFinite = (value: number, label: string) => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new MediaPlanError("INVALID_SIZE_ESTIMATE", `${label} must be positive and finite`);
  }
};
