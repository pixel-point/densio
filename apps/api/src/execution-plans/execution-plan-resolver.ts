import type { ResolvedTrimRange, ResolvedTrimOptions } from "@densio/shared";
import { resolveHlsOptions, validateHlsSource } from "../media/hls-policy.ts";
import {
  DEFAULT_COMPRESSION_CODECS,
  MEDIA_CODEC_POLICY,
  type CompareQualityOptions,
  type ComparisonPosition,
  type CompressionOptions,
  type ResolvedCompressionOptions,
  type ResolvedStoragePlan,
  type ExecutionPlanCreateRequest,
  type ExecutionPlanExpectedArtifact,
  type ExecutionPlanSource,
  type ExecutionPlanSnapshot,
  type ExtractImagesOptions,
  type MediaCodec,
  type ResolvedCompareQualityOptions,
  type ResolvedExtractImagesOptions,
} from "@densio/shared";
import { Effect } from "effect";

import type { Entitlements } from "../auth/entitlements.ts";
import { compressionCreditUnits } from "../billing/compression-credit-cost.ts";
import { creditsFromUnits, MINIMUM_JOB_CREDIT_UNITS } from "../billing/credit-units.ts";
import { MEDIA_CODEC_EXECUTION_POLICY } from "../media/codec-execution-policy.ts";
import { requiresFrameRateDecision } from "../media/frame-rate.ts";
import { resolveVideoDimensions } from "../media/video-filter.ts";
import {
  normalizeQualityComparisonOptions,
  resolveQualityComparisonSamples,
} from "../media/quality-comparison-plan.ts";
import {
  ExecutionPlanCreditGuardExceeded,
  ExecutionPlanEntitlementRejected,
  ExecutionPlanOutputLimitExceeded,
  ExecutionPlanInvalidOptions,
} from "./execution-plan-errors.ts";
import { canonicalDigest } from "../idempotency/canonical-digest.ts";

interface BuildExecutionPlanInput {
  readonly resolvedTrim?: ResolvedTrimRange;
  readonly storage?: ResolvedStoragePlan;
  readonly organizationId: string;
  readonly createdByUserId: string;
  readonly availableCredits: number;
  readonly entitlements: Entitlements;
  readonly maxExtractedImages?: number;
  readonly maxComparisonSeconds?: number;
  readonly resolvedFrameTimestamps?: ReadonlyArray<number>;
  readonly request: ExecutionPlanCreateRequest;
  readonly source: ExecutionPlanSource;
  readonly toolchain: { readonly ffmpegVersion: string; readonly ffprobeVersion: string };
}

export const buildExecutionPlan = Effect.fn("ExecutionPlanResolver.build")(function* (
  input: BuildExecutionPlanInput,
) {
  yield* validateSourceEntitlement(input);
  if (input.request.workflow === "trim")
    return yield* buildTrim({ ...input, request: input.request });
  if (input.request.workflow === "hls")
    return yield* buildHls({ ...input, request: input.request });
  if (input.request.workflow === "compress") {
    return yield* buildCompression({ ...input, request: input.request });
  }
  if (input.request.workflow === "extract-images") {
    return yield* buildExtraction({ ...input, request: input.request });
  }
  return yield* buildComparison({ ...input, request: input.request });
});

const buildCompression = Effect.fn("ExecutionPlanResolver.compression")(function* (
  input: BuildExecutionPlanInput & {
    readonly request: Extract<ExecutionPlanCreateRequest, { readonly workflow: "compress" }>;
  },
) {
  const requestedOptions = input.request.options ?? {};
  const codecs = requestedOptions.codecs ?? DEFAULT_COMPRESSION_CODECS;
  yield* validateCodecs(input.entitlements, codecs);
  const base = commonFields(input);
  if (
    requestedOptions.frameRate === undefined &&
    requiresFrameRateDecision(input.source.inspection.frameRate)
  ) {
    const decision = {
      kind: "frame-rate" as const,
      recommended: { maximum: 30 as const, mode: "cap" as const },
      source: input.source.inspection.frameRate,
    };
    return {
      ...base,
      state: "decision-required",
      workflow: "compress",
      requestedOptions,
      decision,
      intentDigest: planIntentDigest(input, { decision, requestedOptions }),
    } satisfies ExecutionPlanSnapshot;
  }

  if (requestedOptions.trim && !input.resolvedTrim)
    return yield* new ExecutionPlanInvalidOptions({
      message: "Trim range must be resolved before planning.",
    });
  const resolvedOptions = {
    ...resolveCompressionOptions(requestedOptions, codecs),
    ...(input.resolvedTrim ? { trim: input.resolvedTrim } : {}),
  };
  const durationSeconds =
    input.resolvedTrim?.durationSeconds ?? input.source.inspection.durationSeconds;
  const dimensions = yield* resolveDimensions(
    input.source.inspection.displayDimensions,
    resolvedOptions.transform,
  );
  const creditUnits = compressionCreditUnits({
    codecCount: codecs.length,
    durationSeconds,
    output: dimensions,
    source: input.source.inspection.displayDimensions,
  });
  yield* validateCreditGuard(input.request.constraints?.maxCredits, creditUnits);
  const exactQuote = quote(input, creditUnits);
  const expectedArtifacts = codecs.map((codec) =>
    compressionArtifact(codec, dimensions, durationSeconds),
  );

  return {
    ...base,
    state: "ready",
    workflow: "compress",
    requestedOptions,
    resolvedOptions,
    quote: exactQuote,
    warnings: warnings(input),
    expectedArtifacts,
    intentDigest: planIntentDigest(input, {
      expectedArtifacts,
      quote: exactQuote,
      requestedOptions,
      resolvedOptions,
    }),
  } satisfies ExecutionPlanSnapshot;
});

const buildTrim = Effect.fn("ExecutionPlanResolver.trim")(function* (
  input: BuildExecutionPlanInput & {
    request: Extract<ExecutionPlanCreateRequest, { workflow: "trim" }>;
  },
) {
  const requestedOptions = input.request.options;
  const trim = input.resolvedTrim;
  if (!trim)
    return yield* new ExecutionPlanInvalidOptions({
      message: "Trim range must be resolved before planning.",
    });
  const codec = requestedOptions.output.codec;
  yield* validateCodecs(input.entitlements, [codec]);
  const hasAudio = input.source.inspection.audioStreams.length > 0;
  if (requestedOptions.audio === "keep" && !hasAudio)
    return yield* new ExecutionPlanInvalidOptions({
      message: "The source has no audio stream to keep.",
    });
  const resolvedOptions = {
    trim,
    output: { codec, crf: requestedOptions.output.crf ?? MEDIA_CODEC_POLICY[codec].defaultCrf },
    audio: requestedOptions.audio ?? (hasAudio ? "keep" : "remove"),
  } satisfies ResolvedTrimOptions;
  const dimensions = yield* resolveDimensions(input.source.inspection.displayDimensions, undefined);
  const creditUnits = compressionCreditUnits({
    codecCount: 1,
    durationSeconds: trim.durationSeconds,
    source: input.source.inspection.displayDimensions,
    output: dimensions,
  });
  yield* validateCreditGuard(input.request.constraints?.maxCredits, creditUnits);
  const exactQuote = quote(input, creditUnits);
  const expectedArtifacts = [compressionArtifact(codec, dimensions, trim.durationSeconds)];
  return {
    ...commonFields(input),
    state: "ready",
    workflow: "trim",
    requestedOptions,
    resolvedOptions,
    quote: exactQuote,
    expectedArtifacts,
    warnings: [
      ...warnings(input),
      ...(input.source.inspection.streams.length > 1 + Number(hasAudio)
        ? [
            {
              code: "TRIM_SELECTED_STREAMS" as const,
              message: "Only the primary video and first audio stream are retained.",
            },
          ]
        : []),
    ],
    intentDigest: planIntentDigest(input, {
      expectedArtifacts,
      quote: exactQuote,
      requestedOptions,
      resolvedOptions,
    }),
  } satisfies ExecutionPlanSnapshot;
});

const buildHls = Effect.fn("ExecutionPlanResolver.hls")(function* (
  input: BuildExecutionPlanInput & {
    readonly request: Extract<ExecutionPlanCreateRequest, { workflow: "hls" }>;
  },
) {
  yield* validateCodecs(input.entitlements, ["h265"]);
  yield* validateHlsSource(input.source.inspection);
  const requestedOptions = input.request.options ?? {};
  const base = commonFields(input);
  const resolvedOptions = yield* resolveHlsOptions(input.source.inspection, requestedOptions);
  if (
    requestedOptions.frameRate === undefined &&
    requiresFrameRateDecision(input.source.inspection.frameRate)
  ) {
    const decision = {
      kind: "frame-rate" as const,
      recommended: { maximum: 30 as const, mode: "cap" as const },
      source: input.source.inspection.frameRate,
    };
    return {
      ...base,
      state: "decision-required",
      workflow: "hls",
      requestedOptions,
      decision,
      intentDigest: planIntentDigest(input, { decision, requestedOptions }),
    } satisfies ExecutionPlanSnapshot;
  }
  const creditUnits = resolvedOptions.renditions.reduce(
    (sum, output) =>
      sum +
      compressionCreditUnits({
        codecCount: 1,
        durationSeconds: input.source.inspection.durationSeconds,
        source: input.source.inspection.displayDimensions,
        output,
      }),
    0,
  );
  yield* validateCreditGuard(input.request.constraints?.maxCredits, creditUnits);
  const exactQuote = quote(input, creditUnits);
  const expectedArtifacts = [
    {
      kind: "hls-archive" as const,
      filename: "hls.zip",
      mediaType: "application/zip",
      codec: "h265" as const,
      durationSeconds: input.source.inspection.durationSeconds,
    },
  ];
  return {
    ...base,
    state: "ready",
    workflow: "hls",
    requestedOptions,
    resolvedOptions,
    quote: exactQuote,
    expectedArtifacts,
    warnings: [
      ...warnings(input),
      {
        code: "HLS_CFR_TIMELINE",
        message:
          "HLS uses a shared constant frame-rate timeline at the resolved rate for aligned segment switching.",
      },
      ...(resolvedOptions.rateControl.mode === "capped-crf"
        ? [
            {
              code: "HLS_BITRATE_CEILING",
              message:
                "Bitrate ceilings may reduce quality in difficult scenes without changing the requested CRF.",
            },
          ]
        : []),
      ...(input.source.inspection.streams.length >
      1 + Math.min(1, input.source.inspection.audioStreams.length)
        ? [
            {
              code: "HLS_SELECTED_STREAMS",
              message:
                "Only the selected video and first audio stream are retained; subtitles and extra tracks are omitted.",
            },
          ]
        : []),
    ],
    intentDigest: planIntentDigest(input, {
      expectedArtifacts,
      quote: exactQuote,
      requestedOptions,
      resolvedOptions,
    }),
  } satisfies ExecutionPlanSnapshot;
});

const buildExtraction = Effect.fn("ExecutionPlanResolver.extraction")(function* (
  input: BuildExecutionPlanInput & {
    readonly request: Extract<ExecutionPlanCreateRequest, { readonly workflow: "extract-images" }>;
  },
) {
  const requestedOptions = input.request.options ?? {};
  const optionDefaults = resolveExtractionOptions(requestedOptions);
  const outputDimensions = yield* resolveDimensions(
    input.source.inspection.displayDimensions,
    optionDefaults.transform,
  );
  const resolvedOptions = {
    ...optionDefaults,
    outputDimensions,
  } satisfies ResolvedExtractImagesOptions;
  const count = Math.ceil(
    input.source.inspection.durationSeconds / resolvedOptions.intervalSeconds,
  );
  if (count > (input.maxExtractedImages ?? 2_000)) {
    return yield* new ExecutionPlanOutputLimitExceeded({
      estimatedCount: count,
      limit: input.maxExtractedImages ?? 2_000,
    });
  }
  yield* validateCreditGuard(input.request.constraints?.maxCredits, MINIMUM_JOB_CREDIT_UNITS);
  const exactQuote = quote(input, MINIMUM_JOB_CREDIT_UNITS);
  const expectedArtifacts = [
    {
      kind: "image-archive" as const,
      filename: "images.zip",
      mediaType: "application/zip",
      count,
      ...outputDimensions,
    },
  ];

  return {
    ...commonFields(input),
    state: "ready",
    workflow: "extract-images",
    requestedOptions,
    resolvedOptions,
    quote: exactQuote,
    warnings: warnings(input),
    expectedArtifacts,
    intentDigest: planIntentDigest(input, {
      expectedArtifacts,
      quote: exactQuote,
      requestedOptions,
      resolvedOptions,
    }),
  } satisfies ExecutionPlanSnapshot;
});

const buildComparison = Effect.fn("ExecutionPlanResolver.comparison")(function* (
  input: BuildExecutionPlanInput & {
    readonly request: Extract<ExecutionPlanCreateRequest, { readonly workflow: "compare-quality" }>;
  },
) {
  const requestedOptions = input.request.options;
  const selectorOptions = yield* Effect.try({
    catch: () =>
      new ExecutionPlanInvalidOptions({ message: "A frame-index sample could not be resolved." }),
    try: () => resolveComparisonOptions(requestedOptions, input.resolvedFrameTimestamps ?? []),
  });
  const normalized = normalizeQualityComparisonOptions(selectorOptions);
  if (normalized.durationSeconds > (input.maxComparisonSeconds ?? 3)) {
    return yield* new ExecutionPlanInvalidOptions({
      message: "The sample duration exceeds the configured comparison limit.",
    });
  }
  const variants = normalized.variants;
  yield* validateCodecs(
    input.entitlements,
    variants.map(({ codec }) => codec),
  );
  const resolvedSamples = yield* resolveComparisonSamples(input.source.inspection, normalized);
  const dimensions = yield* resolveDimensions(
    input.source.inspection.displayDimensions,
    normalized.transform,
  );
  const aggregateSampleDurationSeconds = resolvedSamples.reduce(
    (sum, sample) => sum + sample.actualSampleDurationSeconds,
    0,
  );
  const creditUnits = compressionCreditUnits({
    codecCount: variants.length,
    durationSeconds: aggregateSampleDurationSeconds,
    output: dimensions,
    source: input.source.inspection.displayDimensions,
  });
  yield* validateCreditGuard(input.request.constraints?.maxCredits, creditUnits);
  const exactQuote = quote(input, creditUnits);
  const expectedArtifacts = variants.flatMap(({ codec, crf }) =>
    comparisonArtifacts(codec, crf, dimensions, aggregateSampleDurationSeconds),
  );
  const resolvedOptions = {
    variants: normalized.variants.map(({ codec, crf }) => ({ codec, crf })),
    bitDepth: normalized.bitDepth,
    objectiveMetrics: normalized.objectiveMetrics,
    samples: resolvedSamples,
    ...(normalized.transform === undefined ? {} : { transform: normalized.transform }),
  } satisfies ResolvedCompareQualityOptions;

  return {
    ...commonFields(input),
    state: "ready",
    workflow: "compare-quality",
    requestedOptions,
    resolvedOptions,
    quote: exactQuote,
    warnings: warnings(input),
    expectedArtifacts,
    intentDigest: planIntentDigest(input, {
      expectedArtifacts,
      quote: exactQuote,
      requestedOptions,
      resolvedOptions,
    }),
  } satisfies ExecutionPlanSnapshot;
});

const commonFields = (input: BuildExecutionPlanInput) => ({
  ...(input.request.workflow === "compress" ||
  input.request.workflow === "trim" ||
  input.request.workflow === "hls"
    ? { storage: input.storage ?? { destination: { kind: "temporary" as const } } }
    : {}),
  organizationId: input.organizationId,
  createdByUserId: input.createdByUserId,
  source: input.source,
  ...(input.request.constraints === undefined ? {} : { constraints: input.request.constraints }),
  toolchain: input.toolchain,
});

interface PlanDigestFields {
  readonly decision?: unknown;
  readonly expectedArtifacts?: ReadonlyArray<ExecutionPlanExpectedArtifact>;
  readonly quote?: {
    readonly kind: "exact";
    readonly creditUnits: number;
    readonly credits: number;
  };
  readonly requestedOptions: unknown;
  readonly resolvedOptions?: unknown;
}

const planIntentDigest = (input: BuildExecutionPlanInput, fields: PlanDigestFields) =>
  canonicalDigest({
    organizationId: input.organizationId,
    ...(input.request.workflow === "compress" ||
    input.request.workflow === "trim" ||
    input.request.workflow === "hls"
      ? { storage: input.storage ?? { destination: { kind: "temporary" } } }
      : {}),
    constraints: input.request.constraints,
    decision: fields.decision,
    expectedArtifacts: fields.expectedArtifacts,
    quote:
      fields.quote === undefined
        ? undefined
        : {
            creditUnits: fields.quote.creditUnits,
            credits: fields.quote.credits,
            kind: fields.quote.kind,
          },
    requestedOptions: fields.requestedOptions,
    resolvedOptions: fields.resolvedOptions,
    sourceSha256: input.source.sha256,
    workflow: input.request.workflow,
  });

const resolveCompressionOptions = (
  options: CompressionOptions,
  codecs: ReadonlyArray<MediaCodec>,
): ResolvedCompressionOptions => ({
  bitDepth: options.bitDepth ?? 8,
  codecs: [...codecs],
  crf: {
    ...(codecs.includes("vp9")
      ? { vp9: options.crf?.vp9 ?? MEDIA_CODEC_POLICY.vp9.defaultCrf }
      : {}),
    ...(codecs.includes("h265")
      ? { h265: options.crf?.h265 ?? MEDIA_CODEC_POLICY.h265.defaultCrf }
      : {}),
    ...(codecs.includes("av1")
      ? { av1: options.crf?.av1 ?? MEDIA_CODEC_POLICY.av1.defaultCrf }
      : {}),
  },
  audio: options.audio ?? "auto",
  frameRate: options.frameRate ?? { mode: "preserve" },
  ...(options.transform === undefined ? {} : { transform: options.transform }),
});

const resolveExtractionOptions = (
  options: ExtractImagesOptions,
): ExtractImagesOptions & {
  readonly format: NonNullable<ExtractImagesOptions["format"]>;
  readonly intervalSeconds: number;
} => ({
  format: options.format ?? "jpeg",
  intervalSeconds: options.intervalSeconds ?? 1,
  ...(options.transform === undefined ? {} : { transform: options.transform }),
});

const resolveComparisonOptions = (
  options: CompareQualityOptions,
  resolvedFrameTimestamps: ReadonlyArray<number>,
): CompareQualityOptions => {
  const frameTimestampByIndex = new Map(
    comparisonFrameIndexes(options).map((frame, index) => [frame, resolvedFrameTimestamps[index]]),
  );
  const resolvePosition = (position: ComparisonPosition): ComparisonPosition => {
    if (position.kind !== "frame") return position;
    const seconds = frameTimestampByIndex.get(position.frame);
    if (seconds === undefined) throw new Error("A frame timestamp is missing");
    return { kind: "seconds", seconds };
  };
  return {
    variants: options.variants,
    bitDepth: options.bitDepth ?? 8,
    objectiveMetrics: options.objectiveMetrics ?? ["ssim"],
    durationSeconds: options.durationSeconds ?? 1,
    samples:
      options.samples?.mode === "positions"
        ? { mode: "positions", positions: options.samples.positions.map(resolvePosition) }
        : (options.samples ?? { mode: "auto", count: 3 }),
    ...(options.transform === undefined ? {} : { transform: options.transform }),
  };
};

const comparisonFrameIndexes = (options: CompareQualityOptions) => {
  if (options.samples?.mode !== "positions") return [];
  return options.samples.positions.flatMap((position) =>
    position.kind === "frame" ? [position.frame] : [],
  );
};

const resolveComparisonSamples = (
  inspection: ExecutionPlanSource["inspection"],
  normalized: ReturnType<typeof normalizeQualityComparisonOptions>,
) =>
  Effect.try({
    catch: () =>
      new ExecutionPlanInvalidOptions({ message: "The comparison samples are not valid." }),
    try: () =>
      resolveQualityComparisonSamples({
        durationSeconds: normalized.durationSeconds,
        sampleSelection: normalized.sampleSelection,
        sourceDurationSeconds: inspection.durationSeconds,
      }),
  });

const resolveDimensions = (
  source: { readonly width: number; readonly height: number },
  transform: CompressionOptions["transform"],
) =>
  Effect.try({
    catch: () => new ExecutionPlanInvalidOptions({ message: "The media transform is invalid." }),
    try: () => resolveVideoDimensions(source, transform),
  });

const compressionArtifact = (
  codec: MediaCodec,
  dimensions: { readonly width: number; readonly height: number },
  durationSeconds: number,
): ExecutionPlanExpectedArtifact => {
  const policy = MEDIA_CODEC_EXECUTION_POLICY[codec];
  return {
    kind: "video",
    filename: `video-${codec}.${policy.fileExtension}`,
    mediaType: policy.mediaType,
    codec,
    ...dimensions,
    durationSeconds,
  };
};

const comparisonArtifacts = (
  codec: MediaCodec,
  crf: number,
  dimensions: { readonly width: number; readonly height: number },
  durationSeconds: number,
): ReadonlyArray<ExecutionPlanExpectedArtifact> => {
  const policy = MEDIA_CODEC_EXECUTION_POLICY[codec];
  const stem = `comparison-${codec}-crf-${crf}`;
  return [
    {
      kind: "preview-video",
      filename: `${stem}.${policy.fileExtension}`,
      mediaType: policy.mediaType,
      codec,
      ...dimensions,
      durationSeconds,
    },
    {
      kind: "preview-image",
      filename: `${stem}.jpg`,
      mediaType: "image/jpeg",
      ...dimensions,
    },
  ];
};

const validateSourceEntitlement = (
  input: Pick<BuildExecutionPlanInput, "entitlements" | "source">,
) => {
  if (input.source.inspection.durationSeconds <= input.entitlements.maxVideoDurationSeconds) {
    return Effect.void;
  }
  return new ExecutionPlanEntitlementRejected({
    durationSeconds: input.source.inspection.durationSeconds,
    limitSeconds: input.entitlements.maxVideoDurationSeconds,
    plan: input.entitlements.plan,
    reason: "duration",
  });
};

const validateCodecs = (entitlements: Entitlements, codecs: ReadonlyArray<MediaCodec>) => {
  const codec = codecs.find((candidate) => !entitlements.allowedCodecs.includes(candidate));
  if (codec === undefined) return Effect.void;
  return new ExecutionPlanEntitlementRejected({
    codec,
    plan: entitlements.plan,
    reason: "codec",
  });
};

const validateCreditGuard = (maxCredits: number | undefined, creditUnits: number) => {
  const requiredCredits = creditsFromUnits(creditUnits);
  if (maxCredits === undefined || maxCredits >= requiredCredits) return Effect.void;
  return new ExecutionPlanCreditGuardExceeded({ maxCredits, requiredCredits });
};

const quote = (input: BuildExecutionPlanInput, creditUnits: number) => ({
  kind: "exact" as const,
  creditUnits,
  credits: creditsFromUnits(creditUnits),
  availableCredits: input.availableCredits,
});

const warnings = (input: BuildExecutionPlanInput) =>
  input.request.constraints?.maxOutputBytes === undefined
    ? []
    : [
        {
          code: "OUTPUT_SIZE_GUARD_IS_POST_ENCODE",
          message:
            "The output-byte guard is measured after encoding and before artifacts are published.",
        },
      ];
