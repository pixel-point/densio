import { Schema } from "effect";
import { IdentifierSchema, IsoTimestampSchema } from "./common-contracts.ts";
import {
  ClientReferenceSchema,
  JobIdempotencyKeySchema,
  JobStateSchema,
  JobWorkflowSchema,
} from "./job-contracts.ts";
import { JobStatusSchema, JobSummarySchema } from "./job-status-contracts.ts";

export const JobListQuerySchema = Schema.Struct({
  state: Schema.optionalKey(JobStateSchema),
  workflow: Schema.optionalKey(JobWorkflowSchema),
  since: Schema.optionalKey(IsoTimestampSchema),
  clientReference: Schema.optionalKey(ClientReferenceSchema),
  idempotencyKey: Schema.optionalKey(JobIdempotencyKeySchema),
  limit: Schema.optionalKey(
    Schema.Finite.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 })),
  ),
  cursor: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(2_000))),
});
export type JobListQuery = typeof JobListQuerySchema.Type;

export const JobListResponseSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  jobs: Schema.Array(JobSummarySchema),
  nextCursor: Schema.optionalKey(Schema.NonEmptyString),
});
export type JobListResponse = typeof JobListResponseSchema.Type;

export const JobLookupQuerySchema = Schema.Struct({
  clientReference: Schema.optionalKey(ClientReferenceSchema),
  idempotencyKey: Schema.optionalKey(JobIdempotencyKeySchema),
}).check(
  Schema.makeFilter(({ clientReference, idempotencyKey }) => {
    if ((clientReference === undefined) === (idempotencyKey === undefined)) {
      return "Provide exactly one client reference or idempotency key";
    }
  }),
);
export type JobLookupQuery = typeof JobLookupQuerySchema.Type;

export const JobLookupResponseSchema = JobStatusSchema;
export type JobLookupResponse = typeof JobLookupResponseSchema.Type;
