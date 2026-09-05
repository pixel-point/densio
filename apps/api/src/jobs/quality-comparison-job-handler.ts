import {
  ResolvedCompareQualityOptionsSchema,
  type ArtifactReceipt,
  type ResolvedCompareQualityOptions,
} from "@densio/shared";
import { Effect, Schema } from "effect";

import { compressionCreditUnits } from "../billing/compression-credit-cost.ts";
import { validateMediaEntitlements } from "../media/inspection/media-entitlement-check.ts";
import { MediaProcessRunner } from "../media/process/media-process-runner.ts";
import { resolveVideoDimensions } from "../media/video-filter.ts";
import {
  type QualityComparisonVariantResult,
  runQualityComparisonWorkflow,
} from "../media/workflows/quality-comparison-workflow.ts";
import { publishAndRegisterArtifacts } from "./artifact-publication.ts";
import {
  analysisIdentityFields,
  assertCurrentAnalysis,
  decodeJobAnalysis,
  decodeJobOptions,
  entitlementsFor,
  inspectJob,
  invalidJobResult,
  meteredAnalysis,
  type JobMediaInspector,
  type MediaJobHandler,
  type MediaJobHandlerContext,
  positiveDurationSchema,
  prepareJobExecution,
  validateJobResult,
} from "./media-job-handler-support.ts";
import type { Job } from "./job-worker.ts";

const QualityComparisonAnalysisSchema = Schema.Struct({
  ...analysisIdentityFields,
  durationSeconds: positiveDurationSchema,
  kind: Schema.Literal("compare-quality"),
});
type QualityComparisonAnalysis = typeof QualityComparisonAnalysisSchema.Type;
export const makeQualityComparisonJobHandler = (
  context: MediaJobHandlerContext,
): MediaJobHandler<typeof QualityComparisonAnalysisSchema.Type> => ({
  analyze: Effect.fn("QualityComparisonJobHandler.analyze")((job) => analyze(context, job)),
  process: Effect.fn("QualityComparisonJobHandler.process")((job, analysis) =>
    process(context, job, analysis),
  ),
});

const analyze = Effect.fn("QualityComparisonJobHandler.inspect")(function* (
  context: MediaJobHandlerContext,
  job: Job,
) {
  const options = yield* decodeJobOptions(
    ResolvedCompareQualityOptionsSchema,
    job.resolvedOptionsJson,
    "quality comparison",
  );
  const inspection = yield* inspectJob(context, job, (inspector, inputFile) =>
    inspectComparison(inspector, job, inputFile, options),
  );
  return meteredAnalysis(inspection.analysis, inspection.creditUnits);
});

const inspectComparison = Effect.fn("QualityComparisonJobHandler.inspectMedia")(function* (
  inspector: JobMediaInspector,
  job: Job,
  inputFile: string,
  options: ResolvedCompareQualityOptions,
) {
  const media = yield* inspector.inspect(inputFile);
  yield* validateMediaEntitlements(
    media,
    [...new Set(options.variants.map(({ codec }) => codec))],
    entitlementsFor(job),
  );
  const samples = options.samples;
  const aggregateDurationSeconds = samples.reduce(
    (total, sample) => total + sample.actualSampleDurationSeconds,
    0,
  );
  return {
    analysis: {
      attempt: job.attemptCount,
      durationSeconds: media.durationSeconds,
      jobId: job.id,
      kind: "compare-quality",
      source: media.displayDimensions,
    } satisfies QualityComparisonAnalysis,
    creditUnits: compressionCreditUnits({
      codecCount: options.variants.length,
      durationSeconds: aggregateDurationSeconds,
      output: resolveVideoDimensions(media.displayDimensions, options.transform),
      source: media.displayDimensions,
    }),
  };
});

const process = Effect.fn("QualityComparisonJobHandler.execute")(function* (
  context: MediaJobHandlerContext,
  job: Job,
  input: typeof QualityComparisonAnalysisSchema.Type,
) {
  const analysis = yield* decodeJobAnalysis(QualityComparisonAnalysisSchema, input);
  assertCurrentAnalysis(job, analysis);
  const options = yield* decodeJobOptions(
    ResolvedCompareQualityOptionsSchema,
    job.resolvedOptionsJson,
    "quality comparison",
  );
  const { paths, recordingRunner } = yield* prepareJobExecution(context, job);
  const workflow = yield* executeWorkflow(context, options, analysis, paths).pipe(
    Effect.provideService(MediaProcessRunner, recordingRunner),
  );
  const dimensions = resolveVideoDimensions(analysis.source, options.transform);
  const sampleDurationSeconds = workflow.samples.reduce(
    (total, sample) => total + sample.actualSampleDurationSeconds,
    0,
  );
  const outputs = workflow.variants.flatMap((variant) => [
    {
      ...variant.preview,
      durationSeconds: sampleDurationSeconds,
      height: dimensions.height,
      width: dimensions.width,
    },
    { ...variant.still, height: dimensions.height, width: dimensions.width },
  ]);
  const published = yield* publishAndRegisterArtifacts(
    context.database,
    context.config,
    job,
    paths,
    outputs,
  );
  const byFilename = new Map(published.map((artifact) => [artifact.filename, artifact]));
  const variants = yield* Effect.forEach(workflow.variants, (variant) =>
    buildComparisonVariant(byFilename, variant),
  );
  return yield* validateJobResult({
    decision: workflow.decision,
    kind: "compare-quality",
    samples: workflow.samples,
    variants,
  });
});

const executeWorkflow = (
  context: MediaJobHandlerContext,
  options: ResolvedCompareQualityOptions,
  analysis: QualityComparisonAnalysis,
  paths: Parameters<typeof runQualityComparisonWorkflow>[0]["paths"],
) =>
  runQualityComparisonWorkflow({
    probeExecutable: context.config.ffprobePath,
    executable: context.config.ffmpegPath,
    paths,
    resolvedOptions: options,
    source: analysis.source,
    sourceDurationSeconds: analysis.durationSeconds,
  });

const buildComparisonVariant = Effect.fn("QualityComparisonJobHandler.buildVariant")(function* (
  byFilename: ReadonlyMap<string, ArtifactReceipt>,
  variant: QualityComparisonVariantResult,
) {
  const preview = byFilename.get(variant.preview.artifactFilename);
  const still = byFilename.get(variant.still.artifactFilename);
  if (preview?.kind !== "preview-video" || still?.kind !== "preview-image") {
    return yield* invalidJobResult();
  }
  return {
    codec: variant.codec,
    crf: variant.crf,
    estimateBasis: "video-only-sample-bitrate-extrapolation" as const,
    estimatedFullVideoBytes: variant.estimatedFullVideoBytes,
    metrics: variant.metrics,
    paretoOptimal: variant.paretoOptimal,
    previewArtifactId: preview.id,
    sampleBytes: variant.sampleBytes,
    stillArtifactId: still.id,
    variantId: variant.variantId,
  };
});
