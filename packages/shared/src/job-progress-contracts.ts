import { Schema } from "effect";
import {
  HttpUrlSchema,
  IdentifierSchema,
  IsoTimestampSchema,
  NonNegativeFiniteSchema,
  NonNegativeIntegerSchema,
  PositiveFiniteSchema,
  PositiveIntegerSchema,
  SafePathComponentSchema,
} from "./common-contracts.ts";
import { MediaCodecSchema } from "./media-options.ts";
import { JobStateSchema } from "./job-contracts.ts";

const ProgressPercentSchema = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 }));

export const JobProgressPhaseSchema = Schema.Literals([
  "queued",
  "inspecting",
  "preparing",
  "encoding",
  "measuring",
  "publishing",
  "complete",
  "failed",
  "canceled",
]);
export type JobProgressPhase = typeof JobProgressPhaseSchema.Type;

export const JobProgressEtaSchema = Schema.Struct({
  minimum: NonNegativeFiniteSchema,
  maximum: NonNegativeFiniteSchema,
}).check(
  Schema.makeFilter(({ maximum, minimum }) => {
    if (maximum < minimum) return "ETA maximum must be greater than or equal to its minimum";
  }),
);
export type JobProgressEta = typeof JobProgressEtaSchema.Type;

export const JobActiveOutputSchema = Schema.Struct({
  index: PositiveIntegerSchema,
  total: PositiveIntegerSchema,
  codec: Schema.optionalKey(MediaCodecSchema),
  filename: Schema.optionalKey(SafePathComponentSchema),
  variantId: Schema.optionalKey(IdentifierSchema),
  processedDurationSeconds: NonNegativeFiniteSchema,
  totalDurationSeconds: PositiveFiniteSchema,
  etaSeconds: Schema.optionalKey(JobProgressEtaSchema),
});
export type JobActiveOutput = typeof JobActiveOutputSchema.Type;

const JobProgressFields = {
  phase: JobProgressPhaseSchema,
  percent: ProgressPercentSchema,
  revision: NonNegativeIntegerSchema,
  attempt: NonNegativeIntegerSchema,
  activeOutputs: Schema.optionalKey(
    Schema.Array(JobActiveOutputSchema).check(Schema.isMinLength(1)),
  ),
};

export const JobProgressSchema = Schema.Struct(JobProgressFields);
export type JobProgress = typeof JobProgressSchema.Type;

const TerminalJobProgressFields = {
  percent: ProgressPercentSchema,
  revision: NonNegativeIntegerSchema,
  attempt: NonNegativeIntegerSchema,
};

export const CompleteJobProgressSchema = Schema.Struct({
  ...TerminalJobProgressFields,
  phase: Schema.Literal("complete"),
  percent: Schema.Literal(100),
});

export const FailedJobProgressSchema = Schema.Struct({
  ...TerminalJobProgressFields,
  phase: Schema.Literal("failed"),
});

export const CanceledJobProgressSchema = Schema.Struct({
  ...TerminalJobProgressFields,
  phase: Schema.Literal("canceled"),
});

export const JobActionKindSchema = Schema.Literals([
  "wait",
  "cancel",
  "authorize-artifacts",
  "materialize",
]);
export type JobActionKind = typeof JobActionKindSchema.Type;

const JobActionTargetFields = {
  url: HttpUrlSchema,
  expiresAt: Schema.optionalKey(IsoTimestampSchema),
};

export const JobActionSchema = Schema.Union([
  Schema.Struct({
    ...JobActionTargetFields,
    kind: Schema.Literal("wait"),
    method: Schema.Literal("GET"),
  }),
  Schema.Struct({
    ...JobActionTargetFields,
    kind: Schema.Literal("cancel"),
    method: Schema.Literal("POST"),
  }),
  Schema.Struct({
    ...JobActionTargetFields,
    kind: Schema.Literal("authorize-artifacts"),
    method: Schema.Literal("POST"),
  }),
  Schema.Struct({
    ...JobActionTargetFields,
    kind: Schema.Literal("materialize"),
    method: Schema.Literal("GET"),
  }),
]);
export type JobAction = typeof JobActionSchema.Type;

export const JobEventKindSchema = Schema.Literals([
  "created",
  "state-changed",
  "artifact-published",
  "progress",
  "terminal",
]);
export type JobEventKind = typeof JobEventKindSchema.Type;

export const JobEventSchema = Schema.Struct({
  sequence: PositiveIntegerSchema,
  jobId: IdentifierSchema,
  kind: JobEventKindSchema,
  state: JobStateSchema,
  progress: JobProgressSchema,
  attempt: NonNegativeIntegerSchema,
  occurredAt: IsoTimestampSchema,
});
export type JobEvent = typeof JobEventSchema.Type;

export const JobEventPageSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  events: Schema.Array(JobEventSchema),
  nextCursor: NonNegativeIntegerSchema,
});
export type JobEventPage = typeof JobEventPageSchema.Type;
