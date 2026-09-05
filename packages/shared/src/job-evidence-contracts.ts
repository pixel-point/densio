import { Schema } from "effect";
import {
  IdentifierSchema,
  IsoTimestampSchema,
  NonNegativeFiniteSchema,
  NonNegativeIntegerSchema,
  PositiveFiniteSchema,
  PositiveIntegerSchema,
  SafePathComponentSchema,
  Sha256Schema,
} from "./common-contracts.ts";
import { ArtifactReceiptSchema, MediaCommandSchema } from "./artifact-contracts.ts";
import { ClientReferenceSchema, JobIdempotencyKeySchema } from "./job-contracts.ts";

export const JobReceiptStreamSchema = Schema.Struct({
  index: NonNegativeIntegerSchema,
  kind: Schema.Literals(["video", "audio", "subtitle", "data", "attachment"]),
  codec: Schema.NonEmptyString,
  width: Schema.optionalKey(PositiveIntegerSchema),
  height: Schema.optionalKey(PositiveIntegerSchema),
  durationSeconds: Schema.optionalKey(PositiveFiniteSchema),
  channels: Schema.optionalKey(PositiveIntegerSchema),
  sampleRate: Schema.optionalKey(PositiveIntegerSchema),
});
export type JobReceiptStream = typeof JobReceiptStreamSchema.Type;

export const JobReceiptSourceSchema = Schema.Struct({
  filename: SafePathComponentSchema,
  declaredBytes: PositiveIntegerSchema,
  verifiedBytes: PositiveIntegerSchema,
  sha256: Sha256Schema,
  durationSeconds: PositiveFiniteSchema,
  encodedWidth: PositiveIntegerSchema,
  encodedHeight: PositiveIntegerSchema,
  displayWidth: PositiveIntegerSchema,
  displayHeight: PositiveIntegerSchema,
  rotationDegrees: Schema.Finite.check(Schema.isInt()),
  frameRate: Schema.Struct({
    numerator: PositiveIntegerSchema,
    denominator: PositiveIntegerSchema,
  }),
  streams: Schema.Array(JobReceiptStreamSchema).check(Schema.isMinLength(1)),
});
export type JobReceiptSource = typeof JobReceiptSourceSchema.Type;

export const JobReceiptIntentSchema = Schema.Struct({
  requestedOptions: Schema.Json,
  resolvedOptions: Schema.Json,
  clientReference: Schema.optionalKey(ClientReferenceSchema),
  idempotencyKey: Schema.optionalKey(JobIdempotencyKeySchema),
  executionPlanId: IdentifierSchema,
  sourceId: IdentifierSchema,
  intentDigest: Sha256Schema,
});
export type JobReceiptIntent = typeof JobReceiptIntentSchema.Type;

export const JobReceiptExecutionSchema = Schema.Struct({
  attempts: NonNegativeIntegerSchema,
  startedAt: Schema.optionalKey(IsoTimestampSchema),
  completedAt: IsoTimestampSchema,
  ffmpegVersion: Schema.optionalKey(Schema.NonEmptyString),
  ffprobeVersion: Schema.optionalKey(Schema.NonEmptyString),
  commands: Schema.Array(MediaCommandSchema),
});
export type JobReceiptExecution = typeof JobReceiptExecutionSchema.Type;

export const JobReceiptBillingSchema = Schema.Struct({
  actualCreditUnits: NonNegativeIntegerSchema,
  actualCredits: NonNegativeFiniteSchema,
}).check(
  Schema.makeFilter(({ actualCreditUnits, actualCredits }) => {
    if (!Number.isSafeInteger(actualCreditUnits)) return "Credit units must be a safe integer";
    if (
      Number(actualCredits.toFixed(2)) !== actualCredits ||
      Math.round(actualCredits * 100) !== actualCreditUnits
    ) {
      return "Actual credits and integer credit units must describe the same charge";
    }
  }),
);
export type JobReceiptBilling = typeof JobReceiptBillingSchema.Type;

export const JobExecutionReceiptSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  createdByUserId: IdentifierSchema,
  source: JobReceiptSourceSchema,
  intent: JobReceiptIntentSchema,
  execution: JobReceiptExecutionSchema,
  billing: JobReceiptBillingSchema,
  artifacts: Schema.Array(ArtifactReceiptSchema),
});
export type JobExecutionReceipt = typeof JobExecutionReceiptSchema.Type;
