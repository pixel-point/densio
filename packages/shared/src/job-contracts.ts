import { Schema } from "effect";

import {
  HttpUrlSchema,
  IdentifierSchema,
  IsoTimestampSchema,
  PlanSchema,
} from "./common-contracts.ts";
import { JobResultSchema } from "./media-results.ts";
import {
  CompareQualityOptionsSchema,
  CompressionOptionsSchema,
  ExtractImagesOptionsSchema,
} from "./media-options.ts";
import { ProblemDetailsSchema } from "./problem-details.ts";

export const JobSourceSchema = Schema.Struct({
  bytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  filename: Schema.NonEmptyString.check(Schema.isPattern(/^[^/\\]+$/)),
});
export type JobSource = typeof JobSourceSchema.Type;

export const CompressionJobRequestSchema = Schema.Struct({
  source: JobSourceSchema,
  options: Schema.optionalKey(CompressionOptionsSchema),
});
export type CompressionJobRequest = typeof CompressionJobRequestSchema.Type;

export const ExtractImagesJobRequestSchema = Schema.Struct({
  source: JobSourceSchema,
  options: Schema.optionalKey(ExtractImagesOptionsSchema),
});
export type ExtractImagesJobRequest = typeof ExtractImagesJobRequestSchema.Type;

export const QualityComparisonJobRequestSchema = Schema.Struct({
  source: JobSourceSchema,
  options: CompareQualityOptionsSchema,
});
export type QualityComparisonJobRequest = typeof QualityComparisonJobRequestSchema.Type;

export const JobWorkflowSchema = Schema.Literals(["compress", "extract-images", "compare-quality"]);
export type JobWorkflow = typeof JobWorkflowSchema.Type;

export const JobStateSchema = Schema.Literals([
  "awaiting-upload",
  "queued",
  "analyzing",
  "processing",
  "succeeded",
  "failed",
  "canceled",
  "expired",
]);
export type JobState = typeof JobStateSchema.Type;

const ProgressPercentSchema = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 }));

const JobStatusBaseSchema = Schema.Struct({
  id: IdentifierSchema,
  workflow: JobWorkflowSchema,
  plan: PlanSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});

const ActiveJobStatusSchema = Schema.Struct({
  ...JobStatusBaseSchema.fields,
  state: Schema.Literals(["awaiting-upload", "queued", "analyzing", "processing"]),
  progressPercent: ProgressPercentSchema,
});

const SucceededJobStatusSchema = Schema.Struct({
  ...JobStatusBaseSchema.fields,
  state: Schema.Literal("succeeded"),
  progressPercent: Schema.Literal(100),
  result: JobResultSchema,
});

const FailedJobStatusSchema = Schema.Struct({
  ...JobStatusBaseSchema.fields,
  state: Schema.Literal("failed"),
  progressPercent: ProgressPercentSchema,
  problem: ProblemDetailsSchema,
});

const CanceledJobStatusSchema = Schema.Struct({
  ...JobStatusBaseSchema.fields,
  state: Schema.Literal("canceled"),
  progressPercent: ProgressPercentSchema,
  problem: Schema.optionalKey(ProblemDetailsSchema),
});

const ExpiredJobStatusSchema = Schema.Struct({
  ...JobStatusBaseSchema.fields,
  state: Schema.Literal("expired"),
  progressPercent: Schema.Literal(100),
});

export const JobStatusSchema = Schema.Union([
  ActiveJobStatusSchema,
  SucceededJobStatusSchema,
  FailedJobStatusSchema,
  CanceledJobStatusSchema,
  ExpiredJobStatusSchema,
]);
export type JobStatus = typeof JobStatusSchema.Type;

export const JobCreatedResponseSchema = Schema.Struct({
  jobId: IdentifierSchema,
  state: Schema.Literal("awaiting-upload"),
  upload: Schema.Struct({
    method: Schema.Literal("PUT"),
    url: HttpUrlSchema,
    expiresAt: IsoTimestampSchema,
  }),
  statusUrl: HttpUrlSchema,
});
export type JobCreatedResponse = typeof JobCreatedResponseSchema.Type;

export const UploadCompletedResponseSchema = Schema.Struct({
  bytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  jobId: IdentifierSchema,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  state: Schema.Literal("queued"),
});
export type UploadCompletedResponse = typeof UploadCompletedResponseSchema.Type;
