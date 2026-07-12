import { stat } from "node:fs/promises";

import type {
  AudioMode,
  ComparisonPosition,
  MediaCodec,
  TransformOptions,
} from "@ffmpeg-api/shared";
import { Effect, Schema } from "effect";

import type { JobStoragePaths } from "../../storage/workspace.ts";
import { resolveStagedFile } from "../../storage/workspace.ts";
import type { AudioAnalysis } from "../compression-plan.ts";
import { buildQualityComparisonPlans, estimateFullVideoBytes } from "../quality-comparison-plan.ts";
import type { VideoDimensions } from "../video-filter.ts";
import { runWorkflowCommands, withCompletedCommands } from "./workflow-command.ts";
import {
  resetWorkflowStaging,
  withWorkflowFailureCleanup,
  workflowFileOperation,
} from "./workflow-staging.ts";
import type { StagedWorkflowOutput, WorkflowCommandDiagnostic } from "./workflow-types.ts";

export { MediaWorkflowProcessError } from "./workflow-command.ts";

export class MediaWorkflowInputError extends Schema.TaggedErrorClass<MediaWorkflowInputError>()(
  "MediaWorkflowInputError",
  { message: Schema.String },
) {}

export interface QualityComparisonWorkflowOptions {
  readonly audio?: AudioMode;
  readonly audioAnalysis?: AudioAnalysis;
  readonly codec: MediaCodec;
  readonly crfs: ReadonlyArray<number>;
  readonly durationSeconds?: number;
  readonly executable?: string;
  readonly paths: JobStoragePaths;
  readonly position?: ComparisonPosition;
  readonly resolvedFrameTimestampSeconds?: number;
  readonly source: VideoDimensions;
  readonly sourceDurationSeconds: number;
  readonly transform?: TransformOptions;
}

export interface QualityComparisonVariantResult {
  readonly crf: number;
  readonly estimatedFullVideoBytes: number;
  readonly preview: StagedWorkflowOutput;
  readonly sampleBytes: number;
  readonly still: StagedWorkflowOutput;
}

export interface QualityComparisonWorkflowResult {
  readonly actualSampleDurationSeconds: number;
  readonly codec: MediaCodec;
  readonly commands: ReadonlyArray<WorkflowCommandDiagnostic>;
  readonly normalizedStartSeconds: number;
  readonly variants: ReadonlyArray<QualityComparisonVariantResult>;
}

export const runQualityComparisonWorkflow = Effect.fn("MediaWorkflow.runQualityComparison")(
  function* (options: QualityComparisonWorkflowOptions) {
    return yield* withWorkflowFailureCleanup(
      options.paths,
      executeQualityComparisonWorkflow(options),
    );
  },
);

const executeQualityComparisonWorkflow = Effect.fn("MediaWorkflow.executeQualityComparison")(
  function* (options: QualityComparisonWorkflowOptions) {
    yield* resetWorkflowStaging(options.paths);
    if (!Number.isFinite(options.sourceDurationSeconds) || options.sourceDurationSeconds <= 0) {
      return yield* new MediaWorkflowInputError({ message: "Source duration must be positive." });
    }

    const outputs = options.crfs.map((crf) => comparisonOutputs(options.codec, crf));
    const outputPaths = yield* Effect.forEach(outputs, (output) =>
      Effect.all({
        preview: resolveStagedFile(options.paths, output.preview.stagedFilename),
        still: resolveStagedFile(options.paths, output.still.stagedFilename),
      }),
    );
    const plans = buildQualityComparisonPlans({
      codec: options.codec,
      crfs: options.crfs,
      executable: options.executable ?? "ffmpeg",
      inputPath: options.paths.inputFile,
      outputPaths,
      source: options.source,
      sourceDurationSeconds: options.sourceDurationSeconds,
      audio: options.audio ?? "remove",
      ...(options.audioAnalysis === undefined ? {} : { audioAnalysis: options.audioAnalysis }),
      ...(options.durationSeconds === undefined
        ? {}
        : { durationSeconds: options.durationSeconds }),
      ...(options.position === undefined ? {} : { position: options.position }),
      ...(options.resolvedFrameTimestampSeconds === undefined
        ? {}
        : { resolvedFrameTimestampSeconds: options.resolvedFrameTimestampSeconds }),
      ...(options.transform === undefined ? {} : { transform: options.transform }),
    });
    const firstPlan = plans[0];
    if (firstPlan === undefined) {
      return yield* new MediaWorkflowInputError({ message: "Comparison variants are required." });
    }
    const actualSampleDurationSeconds = Math.min(
      firstPlan.durationSeconds,
      options.sourceDurationSeconds - firstPlan.startSeconds,
    );
    if (actualSampleDurationSeconds <= 0) {
      return yield* new MediaWorkflowInputError({
        message: "Comparison position must be before the end of the source.",
      });
    }

    const previewCommands = yield* runWorkflowCommands(plans.map((plan) => plan.preview));
    const stillCommands = yield* runWorkflowCommands(
      plans.map((plan) => plan.representativeFrame),
    ).pipe(Effect.mapError((error) => withCompletedCommands(error, previewCommands)));
    const variants = yield* Effect.forEach(outputs, (output, index) =>
      measureVariant(
        output,
        outputPaths[index]?.preview ?? "",
        actualSampleDurationSeconds,
        options.sourceDurationSeconds,
      ),
    );

    return {
      actualSampleDurationSeconds,
      codec: options.codec,
      commands: [...previewCommands, ...stillCommands],
      normalizedStartSeconds: firstPlan.startSeconds,
      variants,
    } satisfies QualityComparisonWorkflowResult;
  },
);

const measureVariant = Effect.fn("MediaWorkflow.measureComparisonVariant")(function* (
  outputs: ReturnType<typeof comparisonOutputs>,
  previewPath: string,
  sampleDurationSeconds: number,
  sourceDurationSeconds: number,
) {
  const metadata = yield* workflowFileOperation("measure-comparison-preview", () =>
    stat(previewPath),
  );

  return {
    crf: outputs.crf,
    estimatedFullVideoBytes: estimateFullVideoBytes({
      sampleBytes: metadata.size,
      sampleDurationSeconds,
      sourceDurationSeconds,
    }),
    preview: outputs.preview,
    sampleBytes: metadata.size,
    still: outputs.still,
  } satisfies QualityComparisonVariantResult;
});

const comparisonOutputs = (codec: MediaCodec, crf: number) => {
  const videoExtension = codec === "h265" ? "mp4" : "webm";
  const mediaType = codec === "h265" ? "video/mp4" : "video/webm";

  return {
    crf,
    preview: {
      artifactFilename: `comparison-${codec}-crf-${crf}.${videoExtension}`,
      codec,
      kind: "preview-video",
      mediaType,
      stagedFilename: `preview-${codec}-crf-${crf}.${videoExtension}`,
    },
    still: {
      artifactFilename: `comparison-${codec}-crf-${crf}.jpg`,
      kind: "preview-image",
      mediaType: "image/jpeg",
      stagedFilename: `still-${codec}-crf-${crf}.jpg`,
    },
  } as const;
};
