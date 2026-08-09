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
import { MEDIA_CODEC_EXECUTION_POLICY } from "../codec-execution-policy.ts";
import { buildQualityComparisonPlans, estimateFullVideoBytes } from "../quality-comparison-plan.ts";
import type { VideoDimensions } from "../video-filter.ts";
import {
  MediaWorkflowProcessError,
  runWorkflowCommand,
  withCompletedCommands,
} from "./workflow-command.ts";
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

    const completedCommands = new Map<number, WorkflowCommandDiagnostic>();
    const pipelines = yield* Effect.forEach(
      plans,
      (plan, index) =>
        runComparisonVariant({
          commandIndex: index * 2,
          completedCommands,
          output: outputs[index],
          paths: outputPaths[index],
          plan,
          sampleDurationSeconds: actualSampleDurationSeconds,
          sourceDurationSeconds: options.sourceDurationSeconds,
        }).pipe(
          Effect.mapError((error) =>
            error instanceof MediaWorkflowProcessError
              ? withCompletedCommands(error, orderedCommands(completedCommands))
              : error,
          ),
        ),
      { concurrency: "unbounded" },
    );

    return {
      actualSampleDurationSeconds,
      codec: options.codec,
      commands: pipelines.flatMap(({ commands }) => commands),
      normalizedStartSeconds: firstPlan.startSeconds,
      variants: pipelines.map(({ variant }) => variant),
    } satisfies QualityComparisonWorkflowResult;
  },
);

interface ComparisonVariantExecution {
  readonly commandIndex: number;
  readonly completedCommands: Map<number, WorkflowCommandDiagnostic>;
  readonly output: ReturnType<typeof comparisonOutputs> | undefined;
  readonly paths: { readonly preview: string; readonly still: string } | undefined;
  readonly plan: ReturnType<typeof buildQualityComparisonPlans>[number];
  readonly sampleDurationSeconds: number;
  readonly sourceDurationSeconds: number;
}

const runComparisonVariant = Effect.fn("MediaWorkflow.runComparisonVariant")(function* (
  options: ComparisonVariantExecution,
) {
  if (options.output === undefined || options.paths === undefined) {
    return yield* new MediaWorkflowInputError({ message: "Comparison output is missing." });
  }
  const preview = yield* runWorkflowCommand(options.plan.preview).pipe(
    Effect.tap((command) =>
      Effect.sync(() => {
        options.completedCommands.set(options.commandIndex, command);
      }),
    ),
  );
  const still = yield* runWorkflowCommand(options.plan.representativeFrame).pipe(
    Effect.tap((command) =>
      Effect.sync(() => {
        options.completedCommands.set(options.commandIndex + 1, command);
      }),
    ),
  );
  const variant = yield* measureVariant(
    options.output,
    options.paths.preview,
    options.sampleDurationSeconds,
    options.sourceDurationSeconds,
  );

  return { commands: [preview, still], variant };
});

const orderedCommands = (commands: ReadonlyMap<number, WorkflowCommandDiagnostic>) =>
  [...commands.entries()].toSorted(([left], [right]) => left - right).map(([, command]) => command);

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
  const policy = MEDIA_CODEC_EXECUTION_POLICY[codec];

  return {
    crf,
    preview: {
      artifactFilename: `comparison-${codec}-crf-${crf}.${policy.fileExtension}`,
      codec,
      kind: "preview-video",
      mediaType: policy.mediaType,
      stagedFilename: `preview-${codec}-crf-${crf}.${policy.fileExtension}`,
    },
    still: {
      artifactFilename: `comparison-${codec}-crf-${crf}.jpg`,
      kind: "preview-image",
      mediaType: "image/jpeg",
      stagedFilename: `still-${codec}-crf-${crf}.jpg`,
    },
  } as const;
};
