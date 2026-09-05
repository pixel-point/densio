import { Schema } from "effect";

export class JobNotFound extends Schema.TaggedErrorClass<JobNotFound>()("JobNotFound", {}) {}

export class JobRepositoryError extends Schema.TaggedErrorClass<JobRepositoryError>()(
  "JobRepositoryError",
  { cause: Schema.Defect(), operation: Schema.String },
) {}
