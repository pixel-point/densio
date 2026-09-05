import { TrimOptionsSchema, ResolvedTrimOptionsSchema } from "./trim-options.ts";
import { HlsOptionsSchema, ResolvedHlsOptionsSchema } from "./hls-contracts.ts";
import { Schema } from "effect";
import { ResolvedStoragePlanSchema } from "./storage-plan-contracts.ts";
import { StorageSelectionSchema } from "./storage-options.ts";

import { ArtifactKindSchema } from "./artifact-contracts.ts";
import {
  HttpUrlSchema,
  IdentifierSchema,
  IsoTimestampSchema,
  NonNegativeFiniteSchema,
  PositiveFiniteSchema,
  PositiveIntegerSchema,
  SafePathComponentSchema,
  Sha256Schema,
} from "./common-contracts.ts";
import {
  CompressionOptionsSchema,
  ResolvedCompressionOptionsSchema,
  ExtractImagesOptionsSchema,
  FrameRatePolicySchema,
  MediaCodecSchema,
  ResolvedExtractImagesOptionsSchema,
} from "./media-options.ts";
import {
  CompareQualityOptionsSchema,
  ResolvedCompareQualityOptionsSchema,
} from "./quality-comparison-options.ts";
import { ClientReferenceSchema, JobStateSchema } from "./job-contracts.ts";
import { ErrorCodeSchema } from "./problem-details.ts";
import { SourceInspectionSchema } from "./source-contracts.ts";

const OutputByteLimitSchema = PositiveIntegerSchema.check(
  Schema.makeFilter((value) => {
    if (!Number.isSafeInteger(value)) return "Output byte limits must be safe integers";
  }),
);
const validateCreditPrecision = (value: number) => {
  const creditUnits = Math.round(value * 100);
  if (!Number.isSafeInteger(creditUnits) || Number(value.toFixed(2)) !== value) {
    return "Credit amounts must map exactly to positive integer hundredths";
  }
};

export const CreditAmountSchema = PositiveFiniteSchema.check(
  Schema.makeFilter(validateCreditPrecision),
);
export type CreditAmount = typeof CreditAmountSchema.Type;

const AvailableCreditAmountSchema = NonNegativeFiniteSchema.check(
  Schema.makeFilter((value) => {
    if (value === 0) return;
    return validateCreditPrecision(value);
  }),
);

export const ExecutionPlanConstraintsSchema = Schema.Struct({
  maxCredits: Schema.optionalKey(CreditAmountSchema),
  maxOutputBytes: Schema.optionalKey(OutputByteLimitSchema),
});
export type ExecutionPlanConstraints = typeof ExecutionPlanConstraintsSchema.Type;

const CompressionExecutionPlanCreateRequestSchema = Schema.Struct({
  storage: Schema.optionalKey(StorageSelectionSchema),
  sourceId: IdentifierSchema,
  workflow: Schema.Literal("compress"),
  options: Schema.optionalKey(CompressionOptionsSchema),
  constraints: Schema.optionalKey(ExecutionPlanConstraintsSchema),
});

const ExtractionExecutionPlanCreateRequestSchema = Schema.Struct({
  sourceId: IdentifierSchema,
  workflow: Schema.Literal("extract-images"),
  options: Schema.optionalKey(ExtractImagesOptionsSchema),
  constraints: Schema.optionalKey(ExecutionPlanConstraintsSchema),
});

const ComparisonExecutionPlanCreateRequestSchema = Schema.Struct({
  sourceId: IdentifierSchema,
  workflow: Schema.Literal("compare-quality"),
  options: CompareQualityOptionsSchema,
  constraints: Schema.optionalKey(ExecutionPlanConstraintsSchema),
});

const HlsExecutionPlanCreateRequestSchema = Schema.Struct({
  sourceId: IdentifierSchema,
  workflow: Schema.Literal("hls"),
  options: Schema.optionalKey(HlsOptionsSchema),
  storage: Schema.optionalKey(StorageSelectionSchema),
  constraints: Schema.optionalKey(ExecutionPlanConstraintsSchema),
});

const TrimExecutionPlanCreateRequestSchema = Schema.Struct({
  sourceId: IdentifierSchema,
  workflow: Schema.Literal("trim"),
  options: TrimOptionsSchema,
  storage: Schema.optionalKey(StorageSelectionSchema),
  constraints: Schema.optionalKey(ExecutionPlanConstraintsSchema),
});

export const ExecutionPlanCreateRequestSchema = Schema.Union([
  TrimExecutionPlanCreateRequestSchema,
  CompressionExecutionPlanCreateRequestSchema,
  ExtractionExecutionPlanCreateRequestSchema,
  ComparisonExecutionPlanCreateRequestSchema,
  HlsExecutionPlanCreateRequestSchema,
]);
export type ExecutionPlanCreateRequest = typeof ExecutionPlanCreateRequestSchema.Type;

export const JobCreateRequestSchema = Schema.Union([
  TrimExecutionPlanCreateRequestSchema.mapFields((fields) => ({
    ...fields,
    clientReference: Schema.optionalKey(ClientReferenceSchema),
  })),
  HlsExecutionPlanCreateRequestSchema.mapFields((fields) => ({
    ...fields,
    clientReference: Schema.optionalKey(ClientReferenceSchema),
  })),
  CompressionExecutionPlanCreateRequestSchema.mapFields((fields) => ({
    ...fields,
    clientReference: Schema.optionalKey(ClientReferenceSchema),
  })),
  ExtractionExecutionPlanCreateRequestSchema.mapFields((fields) => ({
    ...fields,
    clientReference: Schema.optionalKey(ClientReferenceSchema),
  })),
  ComparisonExecutionPlanCreateRequestSchema.mapFields((fields) => ({
    ...fields,
    clientReference: Schema.optionalKey(ClientReferenceSchema),
  })),
]);
export type JobCreateRequest = typeof JobCreateRequestSchema.Type;

export const ExecutionPlanSourceSchema = Schema.Struct({
  sourceId: IdentifierSchema,
  filename: SafePathComponentSchema,
  declaredBytes: PositiveIntegerSchema,
  verifiedBytes: PositiveIntegerSchema,
  sha256: Sha256Schema,
  inspection: SourceInspectionSchema,
});
export type ExecutionPlanSource = typeof ExecutionPlanSourceSchema.Type;

export const ExecutionPlanQuoteSchema = Schema.Struct({
  kind: Schema.Literal("exact"),
  creditUnits: PositiveIntegerSchema,
  credits: CreditAmountSchema,
  availableCredits: AvailableCreditAmountSchema,
}).check(
  Schema.makeFilter(({ creditUnits, credits }) => {
    if (creditUnits !== Math.round(credits * 100)) {
      return "Credit units must equal the exact quoted credit amount";
    }
  }),
);
export type ExecutionPlanQuote = typeof ExecutionPlanQuoteSchema.Type;

export const ExecutionPlanExpectedArtifactSchema = Schema.Struct({
  kind: ArtifactKindSchema,
  filename: SafePathComponentSchema,
  mediaType: Schema.String.check(Schema.isPattern(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i)),
  codec: Schema.optionalKey(MediaCodecSchema),
  width: Schema.optionalKey(PositiveIntegerSchema),
  height: Schema.optionalKey(PositiveIntegerSchema),
  durationSeconds: Schema.optionalKey(PositiveFiniteSchema),
  count: Schema.optionalKey(PositiveIntegerSchema),
});
export type ExecutionPlanExpectedArtifact = typeof ExecutionPlanExpectedArtifactSchema.Type;

export const ExecutionPlanWarningSchema = Schema.Struct({
  code: ErrorCodeSchema,
  message: Schema.NonEmptyString,
});
export type ExecutionPlanWarning = typeof ExecutionPlanWarningSchema.Type;

export const ExecutionPlanActionSchema = Schema.Struct({
  method: Schema.Literal("POST"),
  url: HttpUrlSchema,
  expiresAt: IsoTimestampSchema,
});
export type ExecutionPlanAction = typeof ExecutionPlanActionSchema.Type;

export const ExecutionPlanDecisionSchema = Schema.Struct({
  kind: Schema.Literal("frame-rate"),
  recommended: FrameRatePolicySchema,
  source: Schema.Struct({
    numerator: PositiveIntegerSchema,
    denominator: PositiveIntegerSchema,
    framesPerSecond: PositiveFiniteSchema,
  }),
});
export type ExecutionPlanDecision = typeof ExecutionPlanDecisionSchema.Type;

const SnapshotFields = {
  organizationId: IdentifierSchema,
  createdByUserId: IdentifierSchema,
  source: ExecutionPlanSourceSchema,
  constraints: Schema.optionalKey(ExecutionPlanConstraintsSchema),
  toolchain: Schema.Struct({
    ffmpegVersion: Schema.NonEmptyString,
    ffprobeVersion: Schema.NonEmptyString,
  }),
  intentDigest: Sha256Schema,
};

const ReadySnapshotFields = {
  ...SnapshotFields,
  state: Schema.Literal("ready"),
  quote: ExecutionPlanQuoteSchema,
  warnings: Schema.Array(ExecutionPlanWarningSchema),
  expectedArtifacts: Schema.Array(ExecutionPlanExpectedArtifactSchema).check(Schema.isMinLength(1)),
};

const CompressionSnapshotFields = {
  storage: Schema.optionalKey(ResolvedStoragePlanSchema),
  ...ReadySnapshotFields,
  workflow: Schema.Literal("compress"),
  requestedOptions: CompressionOptionsSchema,
  resolvedOptions: ResolvedCompressionOptionsSchema,
};
const TrimSnapshotFields = {
  storage: Schema.optionalKey(ResolvedStoragePlanSchema),
  ...ReadySnapshotFields,
  workflow: Schema.Literal("trim"),
  requestedOptions: TrimOptionsSchema,
  resolvedOptions: ResolvedTrimOptionsSchema,
};
const ExtractionSnapshotFields = {
  ...ReadySnapshotFields,
  workflow: Schema.Literal("extract-images"),
  requestedOptions: ExtractImagesOptionsSchema,
  resolvedOptions: ResolvedExtractImagesOptionsSchema,
};
const ComparisonSnapshotFields = {
  ...ReadySnapshotFields,
  workflow: Schema.Literal("compare-quality"),
  requestedOptions: CompareQualityOptionsSchema,
  resolvedOptions: ResolvedCompareQualityOptionsSchema,
};
const DecisionSnapshotFields = {
  storage: Schema.optionalKey(ResolvedStoragePlanSchema),
  ...SnapshotFields,
  state: Schema.Literal("decision-required"),
  workflow: Schema.Literal("compress"),
  requestedOptions: CompressionOptionsSchema,
  decision: ExecutionPlanDecisionSchema,
};

const HlsSnapshotFields = {
  storage: Schema.optionalKey(ResolvedStoragePlanSchema),
  ...ReadySnapshotFields,
  workflow: Schema.Literal("hls"),
  requestedOptions: HlsOptionsSchema,
  resolvedOptions: ResolvedHlsOptionsSchema,
};
const HlsDecisionSnapshotFields = {
  ...SnapshotFields,
  storage: Schema.optionalKey(ResolvedStoragePlanSchema),
  state: Schema.Literal("decision-required"),
  workflow: Schema.Literal("hls"),
  requestedOptions: HlsOptionsSchema,
  decision: ExecutionPlanDecisionSchema,
};

export const ReadyExecutionPlanSnapshotSchema = Schema.Union([
  Schema.Struct(CompressionSnapshotFields),
  Schema.Struct(TrimSnapshotFields),
  Schema.Struct(ExtractionSnapshotFields),
  Schema.Struct(ComparisonSnapshotFields),
  Schema.Struct(HlsSnapshotFields),
]);
export type ReadyExecutionPlanSnapshot = typeof ReadyExecutionPlanSnapshotSchema.Type;

export const ExecutionPlanSnapshotSchema = Schema.Union([
  ReadyExecutionPlanSnapshotSchema,
  Schema.Struct(DecisionSnapshotFields),
  Schema.Struct(HlsDecisionSnapshotFields),
]);
export type ExecutionPlanSnapshot = typeof ExecutionPlanSnapshotSchema.Type;

const ProjectionFields = {
  planId: IdentifierSchema,
  createdAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
  supersedesPlanId: Schema.optionalKey(IdentifierSchema),
  availability: Schema.Literals(["available", "expired", "source-unavailable"]),
};
const ReadyProjectionFields = {
  ...ProjectionFields,
  execute: Schema.optionalKey(ExecutionPlanActionSchema),
};
export const ReadyExecutionPlanSchema = Schema.Union([
  Schema.Struct({ ...CompressionSnapshotFields, ...ReadyProjectionFields }),
  Schema.Struct({ ...TrimSnapshotFields, ...ReadyProjectionFields }),
  Schema.Struct({ ...ExtractionSnapshotFields, ...ReadyProjectionFields }),
  Schema.Struct({ ...ComparisonSnapshotFields, ...ReadyProjectionFields }),
  Schema.Struct({ ...HlsSnapshotFields, ...ReadyProjectionFields }),
]).check(
  Schema.makeFilter((plan) => {
    if ((plan.availability === "available") !== (plan.execute !== undefined)) {
      return "Only available plans have an execute action";
    }
  }),
);
export type ReadyExecutionPlan = typeof ReadyExecutionPlanSchema.Type;

export const DecisionRequiredExecutionPlanSchema = Schema.Union([
  Schema.Struct({
    ...DecisionSnapshotFields,
    ...ProjectionFields,
    resolve: Schema.optionalKey(ExecutionPlanActionSchema),
  }),
  Schema.Struct({
    ...HlsDecisionSnapshotFields,
    ...ProjectionFields,
    resolve: Schema.optionalKey(ExecutionPlanActionSchema),
  }),
]).check(
  Schema.makeFilter((plan) => {
    if ((plan.availability === "available") !== (plan.resolve !== undefined)) {
      return "Only available plans have a resolve action";
    }
  }),
);
export type DecisionRequiredExecutionPlan = typeof DecisionRequiredExecutionPlanSchema.Type;

export const ExecutionPlanStatusSchema = Schema.Union([
  ReadyExecutionPlanSchema,
  DecisionRequiredExecutionPlanSchema,
]);
export type ExecutionPlanStatus = typeof ExecutionPlanStatusSchema.Type;

export const ExecutionPlanCreateResponseSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  replayed: Schema.Boolean,
  plan: ExecutionPlanStatusSchema,
});
export type ExecutionPlanCreateResponse = typeof ExecutionPlanCreateResponseSchema.Type;

export const ExecutionPlanResolveRequestSchema = Schema.Struct({
  frameRate: FrameRatePolicySchema,
});
export type ExecutionPlanResolveRequest = typeof ExecutionPlanResolveRequestSchema.Type;

export const ExecutionPlanResolveResponseSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  replayed: Schema.Boolean,
  plan: ReadyExecutionPlanSchema,
});
export type ExecutionPlanResolveResponse = typeof ExecutionPlanResolveResponseSchema.Type;

export const ExecutionPlanExecuteRequestSchema = Schema.Struct({
  maxCredits: Schema.optionalKey(CreditAmountSchema),
  maxOutputBytes: Schema.optionalKey(OutputByteLimitSchema),
  clientReference: Schema.optionalKey(ClientReferenceSchema),
});
export type ExecutionPlanExecuteRequest = typeof ExecutionPlanExecuteRequestSchema.Type;

export const ExecutionPlanExecuteResponseSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  replayed: Schema.Boolean,
  jobId: IdentifierSchema,
  state: JobStateSchema,
  statusUrl: HttpUrlSchema,
});
export type ExecutionPlanExecuteResponse = typeof ExecutionPlanExecuteResponseSchema.Type;
