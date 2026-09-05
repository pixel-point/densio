import { ExecutionPlanDecisionSchema } from "@densio/shared";
import { Schema } from "effect";

export class ExecutionPlanCreditGuardExceeded extends Schema.TaggedErrorClass<ExecutionPlanCreditGuardExceeded>()(
  "ExecutionPlanCreditGuardExceeded",
  {
    maxCredits: Schema.Number,
    requiredCredits: Schema.Number,
  },
) {}

export class ExecutionPlanEntitlementRejected extends Schema.TaggedErrorClass<ExecutionPlanEntitlementRejected>()(
  "ExecutionPlanEntitlementRejected",
  {
    plan: Schema.NonEmptyString,
    reason: Schema.Literals(["codec", "duration"]),
    codec: Schema.optionalKey(Schema.NonEmptyString),
    durationSeconds: Schema.optionalKey(Schema.Number),
    limitSeconds: Schema.optionalKey(Schema.Number),
  },
) {}

export class ExecutionPlanOutputLimitExceeded extends Schema.TaggedErrorClass<ExecutionPlanOutputLimitExceeded>()(
  "ExecutionPlanOutputLimitExceeded",
  {
    estimatedCount: Schema.Number,
    limit: Schema.Number,
  },
) {}

export class ExecutionPlanIdempotencyConflict extends Schema.TaggedErrorClass<ExecutionPlanIdempotencyConflict>()(
  "ExecutionPlanIdempotencyConflict",
  {},
) {}

export class ExecutionPlanNotFound extends Schema.TaggedErrorClass<ExecutionPlanNotFound>()(
  "ExecutionPlanNotFound",
  {},
) {}

export class ExecutionPlanExpired extends Schema.TaggedErrorClass<ExecutionPlanExpired>()(
  "ExecutionPlanExpired",
  {},
) {}

export class ExecutionPlanDecisionRequired extends Schema.TaggedErrorClass<ExecutionPlanDecisionRequired>()(
  "ExecutionPlanDecisionRequired",
  {},
) {}

export class ExecutionPlanSourceUnavailable extends Schema.TaggedErrorClass<ExecutionPlanSourceUnavailable>()(
  "ExecutionPlanSourceUnavailable",
  {},
) {}

export class ExecutionPlanStateConflict extends Schema.TaggedErrorClass<ExecutionPlanStateConflict>()(
  "ExecutionPlanStateConflict",
  { state: Schema.NonEmptyString },
) {}

export class ExecutionPlanStorageError extends Schema.TaggedErrorClass<ExecutionPlanStorageError>()(
  "ExecutionPlanStorageError",
  { cause: Schema.Defect(), operation: Schema.NonEmptyString },
) {}

export class ExecutionPlanCreditsUnavailable extends Schema.TaggedErrorClass<ExecutionPlanCreditsUnavailable>()(
  "ExecutionPlanCreditsUnavailable",
  { availableCredits: Schema.Number, requiredCredits: Schema.Number },
) {}

export class ExecutionPlanClientReferenceConflict extends Schema.TaggedErrorClass<ExecutionPlanClientReferenceConflict>()(
  "ExecutionPlanClientReferenceConflict",
  {},
) {}

export class ExecutionPlanInvalidOptions extends Schema.TaggedErrorClass<ExecutionPlanInvalidOptions>()(
  "ExecutionPlanInvalidOptions",
  { message: Schema.NonEmptyString },
) {}

export class MediaDecisionRequired extends Schema.TaggedErrorClass<MediaDecisionRequired>()(
  "MediaDecisionRequired",
  { sourceId: Schema.String, decision: ExecutionPlanDecisionSchema },
) {}

export class HlsSourceUnsupported extends Schema.TaggedErrorClass<HlsSourceUnsupported>()(
  "HlsSourceUnsupported",
  { reason: Schema.String },
) {}
