import { Schema } from "effect";

export const ApiVersionSchema = Schema.Literal("v1");
export type ApiVersion = typeof ApiVersionSchema.Type;

export const SchemaVersionSchema = Schema.Literal(1);
export type SchemaVersion = typeof SchemaVersionSchema.Type;

export const PLAN_NAMES = ["free", "basic", "pro", "premium"] as const;
export const PlanSchema = Schema.Literals(PLAN_NAMES);
export type Plan = typeof PlanSchema.Type;

export const IdentifierSchema = Schema.NonEmptyString;
export type Identifier = typeof IdentifierSchema.Type;

export const IsoTimestampSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/),
);
export type IsoTimestamp = typeof IsoTimestampSchema.Type;

export const HttpUrlSchema = Schema.String.check(Schema.isPattern(/^https?:\/\/\S+$/));
export type HttpUrl = typeof HttpUrlSchema.Type;

export const PositiveFiniteSchema = Schema.Finite.check(Schema.isGreaterThan(0));
export type PositiveFinite = typeof PositiveFiniteSchema.Type;

export const PositiveIntegerSchema = PositiveFiniteSchema.check(Schema.isInt());
export type PositiveInteger = typeof PositiveIntegerSchema.Type;

export const NonNegativeFiniteSchema = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
export type NonNegativeFinite = typeof NonNegativeFiniteSchema.Type;

export const NonNegativeIntegerSchema = NonNegativeFiniteSchema.check(Schema.isInt());
export type NonNegativeInteger = typeof NonNegativeIntegerSchema.Type;
