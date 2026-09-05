import { Schema } from "effect";

import { HttpUrlSchema, IdentifierSchema, SchemaVersionSchema } from "./common-contracts.ts";

const ProblemTypeSchema = Schema.Union([Schema.Literal("about:blank"), HttpUrlSchema]);

export const ErrorCodeSchema = Schema.String.check(
  Schema.isPattern(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/),
);
export type ErrorCode = typeof ErrorCodeSchema.Type;

export const ProblemDetailsSchema = Schema.Struct({
  type: ProblemTypeSchema,
  title: Schema.NonEmptyString,
  status: Schema.Finite.check(Schema.isInt(), Schema.isBetween({ minimum: 400, maximum: 599 })),
  detail: Schema.NonEmptyString,
  details: Schema.optionalKey(Schema.Json),
  instance: Schema.optionalKey(Schema.NonEmptyString),
  schemaVersion: SchemaVersionSchema,
  code: ErrorCodeSchema,
  retryable: Schema.Boolean,
  suggestedAction: Schema.NonEmptyString,
  correlationId: IdentifierSchema,
  jobId: Schema.optionalKey(IdentifierSchema),
});
export type ProblemDetails = typeof ProblemDetailsSchema.Type;
