import { Schema } from "effect";

export class SourceIdempotencyConflict extends Schema.TaggedErrorClass<SourceIdempotencyConflict>()(
  "SourceIdempotencyConflict",
  {},
) {}

export class SourceNotFound extends Schema.TaggedErrorClass<SourceNotFound>()(
  "SourceNotFound",
  {},
) {}

export class SourceRepositoryError extends Schema.TaggedErrorClass<SourceRepositoryError>()(
  "SourceRepositoryError",
  { cause: Schema.Defect(), operation: Schema.String },
) {}

export class SourceStateConflict extends Schema.TaggedErrorClass<SourceStateConflict>()(
  "SourceStateConflict",
  { state: Schema.String },
) {}

export class SourceUploadExpired extends Schema.TaggedErrorClass<SourceUploadExpired>()(
  "SourceUploadExpired",
  {},
) {}

export class SourceUploadLimitExceeded extends Schema.TaggedErrorClass<SourceUploadLimitExceeded>()(
  "SourceUploadLimitExceeded",
  { limitBytes: Schema.Number },
) {}
