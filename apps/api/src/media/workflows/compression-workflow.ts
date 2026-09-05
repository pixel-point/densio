import type { ResolvedTrimRange } from "@densio/shared";
import {
  DEFAULT_COMPRESSION_CODECS,
  type AudioMode,
  type FrameRatePolicy,
  type MediaCodec,
  type MediaBitDepth,
  type TransformOptions,
} from "@densio/shared";
import { Effect } from "effect";

import { buildCompressionPlan, type AudioAnalysis } from "../compression-plan.ts";
import { verifyVideoBitDepth } from "../inspection/video-bit-depth.ts";
import type { RationalFrameRate } from "../frame-rate.ts";
import { MEDIA_CODEC_EXECUTION_POLICY } from "../codec-execution-policy.ts";
import type { VideoDimensions } from "../video-filter.ts";
import type { JobStoragePaths } from "../../storage/workspace.ts";
import { resolveStagedFile } from "../../storage/workspace.ts";
import { runWorkflowCommands } from "./workflow-command.ts";
import { resetWorkflowStaging, withWorkflowFailureCleanup } from "./workflow-staging.ts";
import type { StagedWorkflowOutput, WorkflowCommandDiagnostic } from "./workflow-types.ts";

export { MediaWorkflowProcessError } from "./workflow-command.ts";

interface CompressionCrfs {
  readonly av1?: number;
  readonly h265?: number;
  readonly vp9?: number;
}

export interface CompressionWorkflowOptions {
  readonly bitDepth?: MediaBitDepth;
  readonly probeExecutable?: string;
  readonly trim?: ResolvedTrimRange;
  readonly audioStreamIndex?: number;
  readonly audio?: AudioMode;
  readonly audioAnalysis?: AudioAnalysis;
  readonly codecs?: ReadonlyArray<MediaCodec>;
  readonly crf?: CompressionCrfs;
  readonly executable?: string;
  readonly frameRate?: FrameRatePolicy;
  readonly paths: JobStoragePaths;
  readonly source: VideoDimensions;
  readonly sourceDurationSeconds?: number;
  readonly sourceFrameRate?: RationalFrameRate;
  readonly transform?: TransformOptions;
}

export interface CompressionWorkflowResult {
  readonly commands: ReadonlyArray<WorkflowCommandDiagnostic>;
  readonly outputs: ReadonlyArray<StagedWorkflowOutput>;
}

export const runCompressionWorkflow = Effect.fn("MediaWorkflow.runCompression")(function* (
  options: CompressionWorkflowOptions,
) {
  return yield* withWorkflowFailureCleanup(options.paths, executeCompressionWorkflow(options));
});

const executeCompressionWorkflow = Effect.fn("MediaWorkflow.executeCompression")(function* (
  options: CompressionWorkflowOptions,
) {
  yield* resetWorkflowStaging(options.paths);
  const codecs = options.codecs ?? DEFAULT_COMPRESSION_CODECS;
  const outputs = codecs.map(compressionOutput);
  const outputPaths = yield* Effect.forEach(outputs, (output) =>
    resolveStagedFile(options.paths, output.stagedFilename),
  );
  const plans = codecs.map((codec, index) =>
    buildCompressionPlan({
      bitDepth: options.bitDepth ?? 8,
      codec,
      ...(options.trim ? { trim: options.trim } : {}),
      ...(options.audioStreamIndex === undefined
        ? {}
        : { audioStreamIndex: options.audioStreamIndex }),
      executable: options.executable ?? "ffmpeg",
      inputPath: options.paths.inputFile,
      outputPath: outputPaths[index] ?? "",
      source: options.source,
      audio: options.audio ?? "auto",
      ...(options.audioAnalysis === undefined ? {} : { audioAnalysis: options.audioAnalysis }),
      ...(options.crf?.[codec] === undefined ? {} : { crf: options.crf[codec] }),
      ...(options.frameRate === undefined ? {} : { frameRate: options.frameRate }),
      ...(options.sourceFrameRate === undefined
        ? {}
        : { sourceFrameRate: options.sourceFrameRate }),
      ...(options.transform === undefined ? {} : { transform: options.transform }),
    }),
  );
  const sourceDurationSeconds = options.trim?.durationSeconds ?? options.sourceDurationSeconds;
  const commands = yield* runWorkflowCommands(
    plans,
    sourceDurationSeconds === undefined
      ? undefined
      : outputs.map((output, index) => ({
          ...(output.codec === undefined ? {} : { codec: output.codec }),
          filename: output.artifactFilename,
          index: index + 1,
          phase: "encoding" as const,
          total: outputs.length,
          totalDurationSeconds: sourceDurationSeconds,
        })),
  );

  if (options.bitDepth === 10)
    yield* Effect.forEach(outputPaths, (path) =>
      verifyVideoBitDepth(options.probeExecutable ?? "ffprobe", path, 10),
    );
  return { commands, outputs } satisfies CompressionWorkflowResult;
});

const compressionOutput = (codec: MediaCodec): StagedWorkflowOutput => {
  const policy = MEDIA_CODEC_EXECUTION_POLICY[codec];

  return {
    artifactFilename: `video-${codec}.${policy.fileExtension}`,
    codec,
    kind: "video",
    mediaType: policy.mediaType,
    stagedFilename: `compressed-${codec}.${policy.fileExtension}`,
  };
};
