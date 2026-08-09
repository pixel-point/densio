import {
  DEFAULT_COMPRESSION_CODECS,
  type AudioMode,
  type MediaCodec,
  type TransformOptions,
} from "@ffmpeg-api/shared";
import { Effect } from "effect";

import { buildCompressionPlan, type AudioAnalysis } from "../compression-plan.ts";
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
  readonly audio?: AudioMode;
  readonly audioAnalysis?: AudioAnalysis;
  readonly codecs?: ReadonlyArray<MediaCodec>;
  readonly crf?: CompressionCrfs;
  readonly executable?: string;
  readonly paths: JobStoragePaths;
  readonly source: VideoDimensions;
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
      codec,
      executable: options.executable ?? "ffmpeg",
      inputPath: options.paths.inputFile,
      outputPath: outputPaths[index] ?? "",
      source: options.source,
      audio: options.audio ?? "auto",
      ...(options.audioAnalysis === undefined ? {} : { audioAnalysis: options.audioAnalysis }),
      ...(options.crf?.[codec] === undefined ? {} : { crf: options.crf[codec] }),
      ...(options.transform === undefined ? {} : { transform: options.transform }),
    }),
  );
  const commands = yield* runWorkflowCommands(plans);

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
