import { stat } from "node:fs/promises";

import type { ComparisonMetrics, MediaCodec, ResolvedCompareQualityOptions } from "@densio/shared";
import { Effect, Schema } from "effect";

import type { JobStoragePaths } from "../../storage/workspace.ts";
import { resolveStagedFile } from "../../storage/workspace.ts";
import { MEDIA_CODEC_EXECUTION_POLICY } from "../codec-execution-policy.ts";
import {
  buildQualityComparisonDecision,
  buildComparisonCoverage,
  qualityComparisonConfidence,
} from "../quality-comparison-decision.ts";
import { parsePsnrMetric, parseSsimMetric } from "../quality-comparison-metrics.ts";
import {
  buildQualityComparisonVariantPlans,
  buildQualityReferencePlan,
  estimateFullVideoBytes,
  type QualityComparisonVariantPlan,
  type ResolvedQualityComparisonSample,
} from "../quality-comparison-plan.ts";
import type { VideoDimensions } from "../video-filter.ts";
import { verifyVideoBitDepth } from "../inspection/video-bit-depth.ts";
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
  readonly probeExecutable?: string;
  readonly executable?: string;
  readonly paths: JobStoragePaths;
  readonly source: VideoDimensions;
  readonly sourceDurationSeconds: number;
  readonly resolvedOptions: ResolvedCompareQualityOptions;
}

export interface QualityComparisonVariantResult {
  readonly codec: MediaCodec;
  readonly crf: number;
  readonly estimatedFullVideoBytes: number;
  readonly metrics: ComparisonMetrics;
  readonly paretoOptimal: boolean;
  readonly preview: StagedWorkflowOutput;
  readonly sampleBytes: number;
  readonly still: StagedWorkflowOutput;
  readonly variantId: string;
}

export interface QualityComparisonWorkflowResult {
  readonly commands: ReadonlyArray<WorkflowCommandDiagnostic>;
  readonly decision: {
    readonly basis: "balanced-ssim-size";
    readonly confidence: "high" | "low" | "medium";
    readonly confidenceBasis: ReturnType<typeof buildComparisonCoverage>;
    readonly paretoVariantIds: ReadonlyArray<string>;
    readonly recommendedVariantId: string;
  };
  readonly samples: ReadonlyArray<ResolvedQualityComparisonSample>;
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

    const normalized = {
      ...options.resolvedOptions,
      variants: options.resolvedOptions.variants.map((variant) => ({
        ...variant,
        variantId: `variant-${variant.codec}-crf-${variant.crf}`,
      })),
    };
    const samples = options.resolvedOptions.samples;
    const paths = yield* resolveWorkflowPaths(options, normalized);
    const completedCommands = new Map<number, WorkflowCommandDiagnostic>();
    const aggregateSampleDurationSeconds = samples.reduce(
      (total, sample) => total + sample.actualSampleDurationSeconds,
      0,
    );
    yield* runIndexedCommand(
      buildQualityReferencePlan({
        bitDepth: normalized.bitDepth ?? 8,
        executable: options.executable ?? "ffmpeg",
        inputPath: options.paths.inputFile,
        outputPath: paths.reference,
        samples,
        source: options.source,
        ...(normalized.transform === undefined ? {} : { transform: normalized.transform }),
      }),
      0,
      completedCommands,
      {
        filename: "quality-reference.mkv",
        index: 1,
        phase: "preparing",
        total: 1,
        totalDurationSeconds: aggregateSampleDurationSeconds,
      },
    );

    if (normalized.bitDepth === 10)
      yield* verifyVideoBitDepth(options.probeExecutable ?? "ffprobe", paths.reference, 10);
    const measured = yield* runComparisonVariants(
      options,
      normalized,
      completedCommands,
      aggregateSampleDurationSeconds,
      paths.reference,
      paths.variants,
    );
    const ranking = buildQualityComparisonDecision(
      measured.map(({ estimatedFullVideoBytes, metrics, variantId }) => ({
        estimatedFullVideoBytes,
        ssim: metrics.ssim,
        variantId,
      })),
    );
    const paretoIds = new Set(ranking.paretoVariantIds);
    const confidenceBasis = buildComparisonCoverage(samples, options.sourceDurationSeconds);

    return {
      commands: orderedCommands(completedCommands),
      decision: {
        basis: "balanced-ssim-size",
        ...ranking,
        confidence: qualityComparisonConfidence(
          confidenceBasis.independentSampleCount,
          confidenceBasis.temporalSpanRatio,
        ),
        confidenceBasis,
      },
      samples,
      variants: measured.map((variant) => ({
        ...variant,
        paretoOptimal: paretoIds.has(variant.variantId),
      })),
    } satisfies QualityComparisonWorkflowResult;
  },
);

interface ComparisonVariantExecution {
  readonly commandIndex: number;
  readonly completedCommands: Map<number, WorkflowCommandDiagnostic>;
  readonly output: ReturnType<typeof comparisonOutput>;
  readonly plan: QualityComparisonVariantPlan;
  readonly sampleDurationSeconds: number;
  readonly sourceDurationSeconds: number;
  readonly variantIndex: number;
  readonly variantTotal: number;
}

const runComparisonVariants = Effect.fn("MediaWorkflow.runComparisonVariants")(function* (
  options: QualityComparisonWorkflowOptions,
  normalized: ResolvedCompareQualityOptions & {
    readonly variants: ReadonlyArray<{
      readonly codec: MediaCodec;
      readonly crf: number;
      readonly variantId: string;
    }>;
  },
  completedCommands: Map<number, WorkflowCommandDiagnostic>,
  sampleDurationSeconds: number,
  referencePath: string,
  outputPaths: Parameters<typeof buildQualityComparisonVariantPlans>[0]["outputPaths"],
) {
  const plans = buildQualityComparisonVariantPlans({
    bitDepth: normalized.bitDepth ?? 8,
    executable: options.executable ?? "ffmpeg",
    objectiveMetrics: normalized.objectiveMetrics,
    outputPaths,
    referencePath,
    sampleDurationSeconds,
    source: options.source,
    variants: normalized.variants,
  });
  const stride = normalized.objectiveMetrics.length + 2;
  const execution = (plan: QualityComparisonVariantPlan, index: number) => ({
    commandIndex: 1 + index * stride,
    completedCommands,
    output: comparisonOutput(plan.codec, plan.crf),
    plan,
    sampleDurationSeconds,
    sourceDurationSeconds: options.sourceDurationSeconds,
    variantIndex: index + 1,
    variantTotal: plans.length,
  });
  yield* Effect.forEach(
    plans,
    (plan, index) =>
      runComparisonPreview(execution(plan, index)).pipe(
        Effect.mapError((error) => attachCompletedCommands(error, completedCommands)),
      ),
    { concurrency: "unbounded" },
  );
  if (normalized.bitDepth === 10)
    yield* Effect.forEach(plans, (plan) =>
      verifyVideoBitDepth(options.probeExecutable ?? "ffprobe", plan.previewPath, 10),
    );
  return yield* Effect.forEach(
    plans,
    (plan, index) =>
      measureComparisonVariant(execution(plan, index)).pipe(
        Effect.mapError((error) => attachCompletedCommands(error, completedCommands)),
      ),
    { concurrency: "unbounded" },
  );
});

const runComparisonPreview = Effect.fn("MediaWorkflow.runComparisonPreview")(function* (
  options: ComparisonVariantExecution,
) {
  yield* runIndexedCommand(options.plan.preview, options.commandIndex, options.completedCommands, {
    codec: options.plan.codec,
    filename: options.output.preview.artifactFilename,
    index: options.variantIndex,
    phase: "encoding",
    total: options.variantTotal,
    totalDurationSeconds: options.sampleDurationSeconds,
    variantId: options.plan.variantId,
  });
});

const measureComparisonVariant = Effect.fn("MediaWorkflow.measureComparisonVariant")(function* (
  options: ComparisonVariantExecution,
) {
  yield* runIndexedCommand(
    options.plan.representativeFrame,
    options.commandIndex + 1,
    options.completedCommands,
  );
  const metricValues = yield* Effect.forEach(options.plan.metrics, (metric, index) =>
    runIndexedCommand(metric.plan, options.commandIndex + index + 2, options.completedCommands, {
      codec: options.plan.codec,
      filename: `${metric.kind}-${options.plan.variantId}.log`,
      index: (options.variantIndex - 1) * options.plan.metrics.length + index + 1,
      phase: "measuring",
      total: options.variantTotal * options.plan.metrics.length,
      totalDurationSeconds: options.sampleDurationSeconds,
      variantId: options.plan.variantId,
    }).pipe(Effect.flatMap((command) => parseMetric(metric.kind, command.stderrTail ?? ""))),
  );
  const metrics = yield* buildMetrics(options.plan.metrics, metricValues);
  const metadata = yield* workflowFileOperation("measure-comparison-preview", () =>
    stat(options.plan.previewPath),
  );

  return {
    codec: options.plan.codec,
    crf: options.plan.crf,
    estimatedFullVideoBytes: estimateFullVideoBytes({
      sampleBytes: metadata.size,
      sampleDurationSeconds: options.sampleDurationSeconds,
      sourceDurationSeconds: options.sourceDurationSeconds,
    }),
    metrics,
    preview: options.output.preview,
    sampleBytes: metadata.size,
    still: options.output.still,
    variantId: options.plan.variantId,
  };
});

const runIndexedCommand = Effect.fn("MediaWorkflow.runIndexedComparisonCommand")(function* (
  plan: QualityComparisonVariantPlan["preview"],
  index: number,
  completedCommands: Map<number, WorkflowCommandDiagnostic>,
  progressContext?: Parameters<typeof runWorkflowCommand>[1],
) {
  return yield* runWorkflowCommand(plan, progressContext).pipe(
    Effect.tap((command) =>
      Effect.sync(() => {
        completedCommands.set(index, command);
      }),
    ),
  );
});

const parseMetric = (kind: "psnr" | "ssim", output: string) =>
  Effect.try({
    try: () => (kind === "ssim" ? parseSsimMetric(output) : parsePsnrMetric(output)),
    catch: () =>
      new MediaWorkflowInputError({
        message: `FFmpeg returned an invalid ${kind.toUpperCase()} metric.`,
      }),
  });

const buildMetrics = Effect.fn("MediaWorkflow.buildComparisonMetrics")(function* (
  plans: QualityComparisonVariantPlan["metrics"],
  values: ReadonlyArray<number | "infinite">,
) {
  const entries = plans.map(({ kind }, index) => [kind, values[index]] as const);
  const ssim = entries.find(([kind]) => kind === "ssim")?.[1];
  if (typeof ssim !== "number" || ssim < 0 || ssim > 1) {
    return yield* new MediaWorkflowInputError({ message: "SSIM is required for comparison." });
  }
  const psnr = entries.find(([kind]) => kind === "psnr")?.[1];

  return {
    ssim,
    ...(psnr === undefined ? {} : { psnr }),
  } satisfies ComparisonMetrics;
});

const resolveWorkflowPaths = Effect.fn("MediaWorkflow.resolveComparisonPaths")(function* (
  options: QualityComparisonWorkflowOptions,
  normalized: ResolvedCompareQualityOptions & {
    readonly variants: ReadonlyArray<{
      readonly codec: MediaCodec;
      readonly crf: number;
      readonly variantId: string;
    }>;
  },
) {
  return {
    reference: yield* resolveStagedFile(options.paths, "quality-reference.mkv"),
    variants: yield* Effect.forEach(normalized.variants, ({ codec, crf }) =>
      Effect.all({
        preview: resolveStagedFile(
          options.paths,
          comparisonOutput(codec, crf).preview.stagedFilename,
        ),
        psnrStats: resolveStagedFile(options.paths, `psnr-${codec}-crf-${crf}.log`),
        ssimStats: resolveStagedFile(options.paths, `ssim-${codec}-crf-${crf}.log`),
        still: resolveStagedFile(options.paths, comparisonOutput(codec, crf).still.stagedFilename),
      }),
    ),
  };
});

const attachCompletedCommands = <Error>(
  error: Error,
  commands: ReadonlyMap<number, WorkflowCommandDiagnostic>,
) =>
  error instanceof MediaWorkflowProcessError
    ? withCompletedCommands(error, orderedCommands(commands))
    : error;

const orderedCommands = (commands: ReadonlyMap<number, WorkflowCommandDiagnostic>) =>
  [...commands.entries()].toSorted(([left], [right]) => left - right).map(([, command]) => command);

const comparisonOutput = (codec: MediaCodec, crf: number) => {
  const policy = MEDIA_CODEC_EXECUTION_POLICY[codec];

  return {
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
