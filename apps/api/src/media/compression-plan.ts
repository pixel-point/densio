import {
  MEDIA_CODEC_POLICY,
  type AudioMode,
  type FrameRatePolicy,
  type MediaCodec,
} from "@densio/shared";

import { assertCommandPath, createCommandPlan } from "./command-plan.ts";
import { MEDIA_CODEC_EXECUTION_POLICY } from "./codec-execution-policy.ts";
import { MediaPlanError } from "./media-plan-error.ts";
import { buildFrameRateFilter, type RationalFrameRate } from "./frame-rate.ts";
import { buildVideoFilters, type TransformOptions, type VideoDimensions } from "./video-filter.ts";

export type { AudioMode, MediaCodec } from "@densio/shared";
export type AudioAnalysis = "absent" | "silent" | "audible";

interface SegmentOptions {
  readonly startSeconds: number;
  readonly durationSeconds: number;
}

export interface CompressionPlanOptions {
  readonly executable?: string;
  readonly inputPath: string;
  readonly outputPath: string;
  readonly codec: MediaCodec;
  readonly crf?: number;
  readonly frameRate?: FrameRatePolicy;
  readonly source: VideoDimensions;
  readonly sourceFrameRate?: RationalFrameRate;
  readonly audio?: AudioMode;
  readonly audioAnalysis?: AudioAnalysis;
  readonly transform?: TransformOptions;
  readonly segment?: SegmentOptions;
}

export interface DefaultCompressionPlanOptions {
  readonly executable?: string;
  readonly inputPath: string;
  readonly outputPaths: { readonly vp9: string; readonly h265: string };
  readonly source: VideoDimensions;
  readonly crf?: { readonly vp9?: number; readonly h265?: number };
  readonly frameRate?: FrameRatePolicy;
  readonly audio?: AudioMode;
  readonly audioAnalysis?: AudioAnalysis;
  readonly transform?: TransformOptions;
  readonly sourceFrameRate?: RationalFrameRate;
}

export const buildDefaultCompressionPlans = (options: DefaultCompressionPlanOptions) => [
  buildCompressionPlan({
    ...sharedCompressionOptions(options),
    codec: "vp9",
    crf: options.crf?.vp9 ?? MEDIA_CODEC_POLICY.vp9.defaultCrf,
    outputPath: options.outputPaths.vp9,
  }),
  buildCompressionPlan({
    ...sharedCompressionOptions(options),
    codec: "h265",
    crf: options.crf?.h265 ?? MEDIA_CODEC_POLICY.h265.defaultCrf,
    outputPath: options.outputPaths.h265,
  }),
];

export const buildCompressionPlan = (options: CompressionPlanOptions) => {
  const executable = options.executable ?? "ffmpeg";
  assertCommandPath(options.inputPath, "Input");
  assertCommandPath(options.outputPath, "Output");
  const crf = options.crf ?? defaultCrfFor(options.codec);
  assertCrf(options.codec, crf);
  const audio = resolveAudioDecision(options.audio ?? "auto", options.audioAnalysis);
  const frameRateFilter = buildFrameRateFilter(options.sourceFrameRate, options.frameRate);
  const filters = [
    ...buildVideoFilters(options.source, options.transform),
    ...(frameRateFilter === undefined ? [] : [frameRateFilter]),
  ];
  const argv = [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-i",
    options.inputPath,
    ...segmentArguments(options.segment),
    "-map",
    "0:v:0",
    ...(audio === "keep" ? ["-map", "0:a:0"] : []),
    ...codecArguments(options.codec, crf),
    ...(filters.length === 0 ? [] : ["-vf", filters.join(",")]),
    "-pix_fmt",
    "yuv420p",
    ...audioArguments(options.codec, audio),
    options.outputPath,
  ];

  return createCommandPlan(executable, argv);
};

export const assertCrf = (codec: MediaCodec, crf: number) => {
  const maximum = codecPolicyFor(codec).crfRange.maximum;
  if (!Number.isSafeInteger(crf) || crf < 0 || crf > maximum) {
    throw new MediaPlanError(
      "INVALID_CRF",
      `${codec.toUpperCase()} CRF must be an integer from 0 to ${maximum}`,
    );
  }
};

const sharedCompressionOptions = (options: DefaultCompressionPlanOptions) => ({
  executable: options.executable ?? "ffmpeg",
  inputPath: options.inputPath,
  source: options.source,
  ...(options.frameRate === undefined ? {} : { frameRate: options.frameRate }),
  ...(options.sourceFrameRate === undefined ? {} : { sourceFrameRate: options.sourceFrameRate }),
  audio: options.audio ?? "auto",
  ...(options.audioAnalysis === undefined ? {} : { audioAnalysis: options.audioAnalysis }),
  ...(options.transform === undefined ? {} : { transform: options.transform }),
});

const codecArguments = (codec: MediaCodec, crf: number) => {
  const execution = codecExecutionPolicyFor(codec);
  if (codec === "vp9") {
    return ["-c:v", execution.encoder, "-b:v", "0", "-crf", String(crf), "-deadline", "best"];
  }
  if (codec === "h265") {
    return [
      "-c:v",
      execution.encoder,
      "-crf",
      String(crf),
      "-preset",
      "veryslow",
      "-tag:v",
      "hvc1",
      "-movflags",
      "faststart",
    ];
  }
  if (codec === "av1") {
    return ["-c:v", execution.encoder, "-b:v", "0", "-crf", String(crf), "-preset", "6"];
  }

  throw new MediaPlanError("INVALID_CODEC", "Media codec is invalid");
};

const audioArguments = (codec: MediaCodec, decision: "keep" | "remove") => {
  if (decision === "remove") return ["-an"];

  return ["-c:a", codecExecutionPolicyFor(codec).audioEncoder];
};

const resolveAudioDecision = (mode: AudioMode, analysis?: AudioAnalysis): "keep" | "remove" => {
  if (mode === "keep" || mode === "remove") return mode;
  if (mode !== "auto") {
    throw new MediaPlanError("INVALID_AUDIO_MODE", "Audio mode is invalid");
  }
  if (analysis === "audible") return "keep";
  if (analysis === "silent" || analysis === "absent") return "remove";

  throw new MediaPlanError(
    "AUDIO_ANALYSIS_REQUIRED",
    "Completed audio analysis is required in automatic mode",
  );
};

const segmentArguments = (segment?: SegmentOptions) => {
  if (segment === undefined) return [];
  assertFinite(segment.startSeconds, "Segment start", 0);
  assertFinite(segment.durationSeconds, "Segment duration", Number.MIN_VALUE);

  return ["-ss", formatNumber(segment.startSeconds), "-t", formatNumber(segment.durationSeconds)];
};

const defaultCrfFor = (codec: MediaCodec) => codecPolicyFor(codec).defaultCrf;

const codecPolicyFor = (codec: MediaCodec) => {
  if (Object.hasOwn(MEDIA_CODEC_POLICY, codec)) return MEDIA_CODEC_POLICY[codec];
  throw new MediaPlanError("INVALID_CODEC", "Media codec is invalid");
};

const codecExecutionPolicyFor = (codec: MediaCodec) => {
  if (Object.hasOwn(MEDIA_CODEC_EXECUTION_POLICY, codec)) {
    return MEDIA_CODEC_EXECUTION_POLICY[codec];
  }
  throw new MediaPlanError("INVALID_CODEC", "Media codec is invalid");
};

const assertFinite = (value: number, label: string, minimum: number) => {
  if (!Number.isFinite(value) || value < minimum) {
    throw new MediaPlanError("INVALID_SEGMENT", `${label} is invalid`);
  }
};

export const formatNumber = (value: number) => String(value);
