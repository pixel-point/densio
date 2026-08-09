import { Schema } from "effect";

export class JobIdempotencyConflict extends Schema.TaggedErrorClass<JobIdempotencyConflict>()(
  "JobIdempotencyConflict",
  {},
) {}

export class JobCreditsExhausted extends Schema.TaggedErrorClass<JobCreditsExhausted>()(
  "JobCreditsExhausted",
  { availableCredits: Schema.Number, monthlyCredits: Schema.Number },
) {}

export class JobUploadExpired extends Schema.TaggedErrorClass<JobUploadExpired>()(
  "JobUploadExpired",
  {},
) {}

export class JobNotFound extends Schema.TaggedErrorClass<JobNotFound>()("JobNotFound", {}) {}

export class JobStateConflict extends Schema.TaggedErrorClass<JobStateConflict>()(
  "JobStateConflict",
  { state: Schema.String },
) {}

export class JobUploadLimitExceeded extends Schema.TaggedErrorClass<JobUploadLimitExceeded>()(
  "JobUploadLimitExceeded",
  { limitBytes: Schema.Number },
) {}

export class JobComparisonDurationExceeded extends Schema.TaggedErrorClass<JobComparisonDurationExceeded>()(
  "JobComparisonDurationExceeded",
  { limitSeconds: Schema.Number },
) {}

export class JobRepositoryError extends Schema.TaggedErrorClass<JobRepositoryError>()(
  "JobRepositoryError",
  { cause: Schema.Defect(), operation: Schema.String },
) {}
