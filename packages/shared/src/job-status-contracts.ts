import { VideoSchema } from "./video-contracts.ts";
import { Schema } from "effect";
import { IdentifierSchema, IsoTimestampSchema, PlanSchema } from "./common-contracts.ts";
import { ArtifactDescriptorSchema } from "./artifact-contracts.ts";
import { JobResultSchema } from "./media-results.ts";
import { ProblemDetailsSchema } from "./problem-details.ts";
import {
  ClientReferenceSchema,
  JobIdempotencyKeySchema,
  JobStateSchema,
  JobWorkflowSchema,
} from "./job-contracts.ts";
import {
  JobActionSchema,
  JobProgressSchema,
  CompleteJobProgressSchema,
  FailedJobProgressSchema,
  CanceledJobProgressSchema,
} from "./job-progress-contracts.ts";
import { JobExecutionReceiptSchema } from "./job-evidence-contracts.ts";

export const JobStatusBaseSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  createdByUserId: IdentifierSchema,
  id: IdentifierSchema,
  sourceId: IdentifierSchema,
  executionPlanId: IdentifierSchema,
  workflow: JobWorkflowSchema,
  plan: PlanSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  clientReference: Schema.optionalKey(ClientReferenceSchema),
  idempotencyKey: Schema.optionalKey(JobIdempotencyKeySchema),
  actions: Schema.Array(JobActionSchema),
});

const ActiveJobStatusSchema = Schema.Struct({
  ...JobStatusBaseSchema.fields,
  state: Schema.Literals(["preparing", "queued", "analyzing", "processing", "publishing"]),
  progress: JobProgressSchema,
});

const SucceededJobStatusSchema = Schema.Struct({
  ...JobStatusBaseSchema.fields,
  state: Schema.Literal("succeeded"),
  progress: CompleteJobProgressSchema,
  video: Schema.optionalKey(VideoSchema),
  artifacts: Schema.Array(ArtifactDescriptorSchema),
  result: JobResultSchema,
  receipt: JobExecutionReceiptSchema,
});

const FailedJobStatusSchema = Schema.Struct({
  ...JobStatusBaseSchema.fields,
  state: Schema.Literal("failed"),
  progress: FailedJobProgressSchema,
  problem: ProblemDetailsSchema,
  receipt: JobExecutionReceiptSchema,
});

const CanceledJobStatusSchema = Schema.Struct({
  ...JobStatusBaseSchema.fields,
  state: Schema.Literal("canceled"),
  progress: CanceledJobProgressSchema,
  problem: Schema.optionalKey(ProblemDetailsSchema),
  receipt: JobExecutionReceiptSchema,
});

export const JobStatusSchema = Schema.Union([
  ActiveJobStatusSchema,
  SucceededJobStatusSchema,
  FailedJobStatusSchema,
  CanceledJobStatusSchema,
]);
export type JobStatus = typeof JobStatusSchema.Type;

export const JobSummarySchema = Schema.Struct({
  ...JobStatusBaseSchema.fields,
  state: JobStateSchema,
  progress: JobProgressSchema,
});
export type JobSummary = typeof JobSummarySchema.Type;
