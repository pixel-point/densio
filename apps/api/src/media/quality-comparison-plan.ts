import type {
  CompareQualityOptions,
  ComparisonObjectiveMetrics,
  ComparisonPosition,
  ComparisonSamples,
  MediaBitDepth,
} from "@densio/shared";

import { assertCommandPath, createCommandPlan, type CommandPlan } from "./command-plan.ts";
import {
  assertCrf,
  buildCompressionPlan,
  formatNumber,
  type MediaCodec,
} from "./compression-plan.ts";
import { MediaPlanError } from "./media-plan-error.ts";
import { buildVideoFilters, type TransformOptions, type VideoDimensions } from "./video-filter.ts";

export type { ComparisonPosition } from "@densio/shared";

interface ComparisonOutputPaths {
  readonly preview: string;
  readonly still: string;
}

export interface NormalizedQualityComparisonVariant {
  readonly codec: MediaCodec;
  readonly crf: number;
  readonly variantId: string;
}

export interface NormalizedQualityComparisonOptions {
  readonly bitDepth: MediaBitDepth;
  readonly durationSeconds: number;
  readonly objectiveMetrics: ComparisonObjectiveMetrics;
  readonly sampleSelection: ComparisonSamples;
  readonly transform?: TransformOptions;
  readonly variants: ReadonlyArray<NormalizedQualityComparisonVariant>;
}

interface PositionSamples {
  readonly mode: "positions";
  readonly positions: ReadonlyArray<ComparisonPosition>;
}

export interface ResolvedQualityComparisonSample {
  readonly actualSampleDurationSeconds: number;
  readonly normalizedStartSeconds: number;
  readonly sampleId: string;
}

interface ResolveQualityComparisonSamplesOptions {
  readonly durationSeconds: number;
  readonly resolvedFrameTimestamps?: ReadonlyArray<number | null>;
  readonly sampleSelection: ComparisonSamples;
  readonly sourceDurationSeconds: number;
}

interface QualityReferencePlanOptions {
  readonly bitDepth?: MediaBitDepth;
  readonly executable?: string;
  readonly inputPath: string;
  readonly outputPath: string;
  readonly samples: ReadonlyArray<ResolvedQualityComparisonSample>;
  readonly source: VideoDimensions;
  readonly transform?: TransformOptions;
}

interface QualityMetricPlanOptions {
  readonly executable?: string;
  readonly kind: "psnr" | "ssim";
  readonly previewPath: string;
  readonly referencePath: string;
  readonly statsPath: string;
}

interface QualityVariantOutputPaths extends ComparisonOutputPaths {
  readonly psnrStats?: string;
  readonly ssimStats: string;
}

interface QualityComparisonVariantPlansOptions {
  readonly bitDepth?: MediaBitDepth;
  readonly executable?: string;
  readonly objectiveMetrics: ComparisonObjectiveMetrics;
  readonly outputPaths: ReadonlyArray<QualityVariantOutputPaths>;
  readonly referencePath: string;
  readonly sampleDurationSeconds: number;
  readonly source: VideoDimensions;
  readonly variants: ReadonlyArray<NormalizedQualityComparisonVariant>;
}

export interface QualityComparisonMetricPlan {
  readonly kind: "psnr" | "ssim";
  readonly plan: CommandPlan;
  readonly statsPath: string;
}

export interface QualityComparisonVariantPlan {
  readonly codec: MediaCodec;
  readonly crf: number;
  readonly metrics: ReadonlyArray<QualityComparisonMetricPlan>;
  readonly preview: CommandPlan;
  readonly previewPath: string;
  readonly representativeFrame: CommandPlan;
  readonly variantId: string;
}

interface EstimateFullVideoBytesOptions {
  readonly sampleBytes: number;
  readonly sampleDurationSeconds: number;
  readonly sourceDurationSeconds: number;
}

export const normalizeQualityComparisonOptions = (
  options: CompareQualityOptions,
): NormalizedQualityComparisonOptions => ({
  bitDepth: options.bitDepth ?? 8,
  durationSeconds: options.durationSeconds ?? 1,
  objectiveMetrics: options.objectiveMetrics ?? ["ssim"],
  sampleSelection: options.samples ?? { mode: "auto", count: 3 },
  ...(options.transform === undefined ? {} : { transform: options.transform }),
  variants: options.variants.map(({ codec, crf }) => ({
    codec,
    crf,
    variantId: variantId(codec, crf),
  })),
});

export const resolveQualityComparisonSamples = (
  options: ResolveQualityComparisonSamplesOptions,
): ReadonlyArray<ResolvedQualityComparisonSample> => {
  assertSampleDuration(options.durationSeconds);
  assertPositiveSourceDuration(options.sourceDurationSeconds);
  if (options.sampleSelection.mode === "auto") {
    return resolveAutoSamples(options, options.sampleSelection);
  }

  return resolvePositionSamples(options, options.sampleSelection);
};

export const buildQualityReferencePlan = (options: QualityReferencePlanOptions) => {
  if (options.samples.length === 0 || options.samples.length > 5) {
    throw new MediaPlanError("INVALID_COMPARISON_SAMPLES", "Comparison requires 1 to 5 samples");
  }
  assertCommandPath(options.inputPath, "Input");
  assertCommandPath(options.outputPath, "Reference");
  const videoFilters = buildVideoFilters(options.source, options.transform);
  const sampleFilters = options.samples.map((sample, index) => {
    assertNonNegativeFinite(sample.normalizedStartSeconds, "Comparison sample position");
    assertPositiveFinite(sample.actualSampleDurationSeconds, "Comparison sample duration");
    const filters = [
      `trim=start=${formatNumber(sample.normalizedStartSeconds)}:duration=${formatNumber(sample.actualSampleDurationSeconds)}`,
      "setpts=PTS-STARTPTS",
      ...videoFilters,
    ];

    const input = options.samples.length === 1 ? "[0:v:0]" : `[input${index}]`;

    return `${input}${filters.join(",")}[sample${index}]`;
  });
  const inputs = options.samples.map((_, index) => `[sample${index}]`).join("");
  const split =
    options.samples.length === 1
      ? []
      : [
          `[0:v:0]split=${options.samples.length}${options.samples
            .map((_, index) => `[input${index}]`)
            .join("")}`,
        ];
  const filter = [
    ...split,
    ...sampleFilters,
    `${inputs}concat=n=${options.samples.length}:v=1:a=0[reference]`,
  ].join(";");

  return createCommandPlan(options.executable ?? "ffmpeg", [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    options.inputPath,
    "-filter_complex",
    filter,
    "-map",
    "[reference]",
    "-an",
    "-c:v",
    "ffv1",
    "-pix_fmt",
    options.bitDepth === 10 ? "yuv420p10le" : "yuv420p",
    options.outputPath,
  ]);
};

export const buildQualityMetricPlan = (options: QualityMetricPlanOptions) => {
  assertCommandPath(options.previewPath, "Preview");
  assertCommandPath(options.referencePath, "Reference");
  assertCommandPath(options.statsPath, "Metric stats");
  if (options.kind !== "ssim" && options.kind !== "psnr") {
    throw new MediaPlanError("INVALID_COMPARISON_METRIC", "Comparison metric is invalid");
  }

  return createCommandPlan(options.executable ?? "ffmpeg", [
    "-hide_banner",
    "-nostdin",
    "-i",
    options.previewPath,
    "-i",
    options.referencePath,
    "-lavfi",
    `${options.kind}=stats_file=${options.statsPath}`,
    "-f",
    "null",
    "-",
  ]);
};

export const buildQualityComparisonVariantPlans = (
  options: QualityComparisonVariantPlansOptions,
) => {
  assertComparisonVariants(options.variants);
  assertPositiveFinite(options.sampleDurationSeconds, "Aggregate sample duration");
  if (options.outputPaths.length !== options.variants.length) {
    throw new MediaPlanError(
      "OUTPUT_PATH_COUNT_MISMATCH",
      "An output path set is required for every comparison variant",
    );
  }

  return options.variants.map((variant, index): QualityComparisonVariantPlan => {
    const paths = options.outputPaths[index];
    if (paths === undefined) {
      throw new MediaPlanError("OUTPUT_PATH_COUNT_MISMATCH", "Comparison output path is missing");
    }
    const metrics = options.objectiveMetrics.map((kind): QualityComparisonMetricPlan => {
      const statsPath = kind === "ssim" ? paths.ssimStats : paths.psnrStats;
      if (statsPath === undefined) {
        throw new MediaPlanError(
          "OUTPUT_PATH_COUNT_MISMATCH",
          "Comparison metric stats path is missing",
        );
      }

      return {
        kind,
        plan: buildQualityMetricPlan({
          executable: options.executable ?? "ffmpeg",
          kind,
          previewPath: paths.preview,
          referencePath: options.referencePath,
          statsPath,
        }),
        statsPath,
      };
    });

    return {
      ...variant,
      metrics,
      preview: buildCompressionPlan({
        bitDepth: options.bitDepth ?? 8,
        executable: options.executable ?? "ffmpeg",
        codec: variant.codec,
        crf: variant.crf,
        inputPath: options.referencePath,
        outputPath: paths.preview,
        source: options.source,
        audio: "remove",
      }),
      previewPath: paths.preview,
      representativeFrame: buildRepresentativeFramePlan(
        options.executable ?? "ffmpeg",
        paths,
        options.sampleDurationSeconds,
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

const resolveAutoSamples = (
  options: ResolveQualityComparisonSamplesOptions,
  sampleSelection: { readonly count: number; readonly mode: "auto" },
) => {
  const { count } = sampleSelection;
  if (!Number.isSafeInteger(count) || count < 1 || count > 5) {
    throw new MediaPlanError(
      "INVALID_COMPARISON_SAMPLES",
      "Automatic samples require a count of 1 to 5",
    );
  }
  const duration = Math.min(options.durationSeconds, options.sourceDurationSeconds);
  const maximumStart = options.sourceDurationSeconds - duration;

  return Array.from({ length: count }, (_, index) => {
    const center = (options.sourceDurationSeconds * (index + 1)) / (count + 1);
    const start = Math.min(maximumStart, Math.max(0, center - duration / 2));

    return comparisonSample(index, start, duration);
  });
};

const resolvePositionSamples = (
  options: ResolveQualityComparisonSamplesOptions,
  sampleSelection: PositionSamples,
) => {
  const { positions } = sampleSelection;
  if (positions.length === 0 || positions.length > 5) {
    throw new MediaPlanError(
      "INVALID_COMPARISON_SAMPLES",
      "Position samples require 1 to 5 positions",
    );
  }

  return positions.map((position, index) => {
    const frameTimestamp = options.resolvedFrameTimestamps?.[index];
    const normalized = normalizePosition(position, frameTimestamp ?? undefined);
    const duration = resolveActualDuration(
      options.durationSeconds,
      normalized.seconds,
      options.sourceDurationSeconds,
    );

    return comparisonSample(index, normalized.seconds, duration);
  });
};

const comparisonSample = (index: number, start: number, duration: number) => ({
  actualSampleDurationSeconds: duration,
  normalizedStartSeconds: start,
  sampleId: `sample-${index + 1}`,
});

const variantId = (codec: MediaCodec, crf: number) => `variant-${codec}-crf-${crf}`;

const assertComparisonVariants = (variants: ReadonlyArray<NormalizedQualityComparisonVariant>) => {
  if (variants.length < 2 || variants.length > 8) {
    throw new MediaPlanError("INVALID_COMPARISON_VARIANTS", "Comparison requires 2 to 8 variants");
  }
  const pairs = variants.map(({ codec, crf }) => `${codec}:${crf}`);
  if (new Set(pairs).size !== pairs.length) {
    throw new MediaPlanError("DUPLICATE_COMPARISON_VARIANT", "Comparison variants must be unique");
  }
  variants.forEach(({ codec, crf }) => assertCrf(codec, crf));
};

const assertPositiveSourceDuration = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new MediaPlanError("INVALID_SOURCE_DURATION", "Source duration must be positive");
  }
};
