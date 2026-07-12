import {
  CompareQualityOptionsSchema,
  type ArtifactMetadata,
  type CompareQualityOptions,
} from "@ffmpeg-api/shared";
import { Effect, Schema } from "effect";

import { validateMediaEntitlements } from "../media/inspection/media-entitlement-check.ts";
import type { MediaInspector } from "../media/inspection/media-inspector.ts";
import { MediaProcessRunner } from "../media/process/media-process-runner.ts";
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
  type MediaJobHandler,
  type MediaJobHandlerContext,
  positiveDurationSchema,
  prepareJobExecution,
  sanitizeCommands,
  validateJobResult,
} from "./media-job-handler-support.ts";
import type { Job } from "./job-worker.ts";

const QualityComparisonAnalysisSchema = Schema.Struct({
  ...analysisIdentityFields,
  durationSeconds: positiveDurationSchema,
  kind: Schema.Literal("compare-quality"),
  resolvedFrameTimestampSeconds: Schema.NullOr(
    Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
});
type QualityComparisonAnalysis = typeof QualityComparisonAnalysisSchema.Type;

export const makeQualityComparisonJobHandler = (
  context: MediaJobHandlerContext,
): MediaJobHandler => ({
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
    CompareQualityOptionsSchema,
    job.optionsJson,
    "quality comparison",
  );
  return yield* inspectJob(context, job, (inspector, inputFile) =>
    inspectComparison(inspector, job, inputFile, options),
  );
});

const inspectComparison = Effect.fn("QualityComparisonJobHandler.inspectMedia")(function* (
  inspector: MediaInspector["Service"],
  job: Job,
  inputFile: string,
  options: CompareQualityOptions,
) {
  const media = yield* inspector.inspect(inputFile);
  yield* validateMediaEntitlements(media, [options.codec], entitlementsFor(job));
  const resolvedFrameTimestampSeconds =
    options.position?.kind === "frame"
      ? yield* inspector.resolveFrameTimestamp(
          inputFile,
          options.position.frame,
          media.videoStreamIndex,
        )
      : null;
  return {
    attempt: job.attemptCount,
    durationSeconds: media.durationSeconds,
    jobId: job.id,
    kind: "compare-quality",
    resolvedFrameTimestampSeconds,
    source: media.displayDimensions,
  } satisfies QualityComparisonAnalysis;
});

const process = Effect.fn("QualityComparisonJobHandler.execute")(function* (
  context: MediaJobHandlerContext,
  job: Job,
  input: Schema.Json,
) {
  const analysis = yield* decodeJobAnalysis(QualityComparisonAnalysisSchema, input);
  assertCurrentAnalysis(job, analysis);
  const options = yield* decodeJobOptions(
    CompareQualityOptionsSchema,
    job.optionsJson,
    "quality comparison",
  );
  const { paths, recordingRunner } = yield* prepareJobExecution(context, job);
  const workflow = yield* runQualityComparisonWorkflow({
    codec: options.codec,
    crfs: options.crfs,
    executable: context.config.ffmpegPath,
    paths,
    source: analysis.source,
    sourceDurationSeconds: analysis.durationSeconds,
    ...(options.durationSeconds === undefined ? {} : { durationSeconds: options.durationSeconds }),
    ...(options.position === undefined ? {} : { position: options.position }),
    ...(analysis.resolvedFrameTimestampSeconds === null
      ? {}
      : { resolvedFrameTimestampSeconds: analysis.resolvedFrameTimestampSeconds }),
    ...(options.transform === undefined ? {} : { transform: options.transform }),
  }).pipe(Effect.provideService(MediaProcessRunner, recordingRunner));
  const outputs = workflow.variants.flatMap((variant) => [variant.preview, variant.still]);
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
    actualSampleDurationSeconds: workflow.actualSampleDurationSeconds,
    codec: workflow.codec,
    commands: sanitizeCommands(workflow.commands),
    kind: "compare-quality",
    normalizedStartSeconds: workflow.normalizedStartSeconds,
    variants,
  });
});

const buildComparisonVariant = Effect.fn("QualityComparisonJobHandler.buildVariant")(function* (
  byFilename: ReadonlyMap<string, ArtifactMetadata>,
  variant: QualityComparisonVariantResult,
) {
  const preview = byFilename.get(variant.preview.artifactFilename);
  const still = byFilename.get(variant.still.artifactFilename);
  if (preview?.kind !== "preview-video" || still?.kind !== "preview-image") {
    return yield* invalidJobResult();
  }
  return {
    crf: variant.crf,
    estimateBasis: "sample-bitrate-extrapolation" as const,
    estimatedFullVideoBytes: variant.estimatedFullVideoBytes,
    preview: { ...preview, kind: "preview-video" as const },
    sampleBytes: variant.sampleBytes,
    still: { ...still, kind: "preview-image" as const },
  };
});
