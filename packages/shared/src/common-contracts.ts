import { Schema } from "effect";

export const ApiVersionSchema = Schema.Literal("v1");
export type ApiVersion = typeof ApiVersionSchema.Type;

export const SchemaVersionSchema = Schema.Literal(1);
export type SchemaVersion = typeof SchemaVersionSchema.Type;

export const PLAN_NAMES = ["free", "basic", "pro", "scale"] as const;
export const PlanSchema = Schema.Literals(PLAN_NAMES);
export type Plan = typeof PlanSchema.Type;

export const IdentifierSchema = Schema.NonEmptyString;
export type Identifier = typeof IdentifierSchema.Type;

export const IsoTimestampSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/),
  Schema.makeFilter((value) => {
    const date = new Date(value);
    return (
      (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19)) ||
      "Expected a valid UTC timestamp"
    );
  }),
);
export type IsoTimestamp = typeof IsoTimestampSchema.Type;

export const HttpUrlSchema = Schema.String.check(
  Schema.isPattern(/^https?:\/\/\S+$/),
  Schema.makeFilter((value) => URL.canParse(value) || "Expected a valid HTTP URL"),
);
export type HttpUrl = typeof HttpUrlSchema.Type;

export const PositiveFiniteSchema = Schema.Finite.check(Schema.isGreaterThan(0));
export type PositiveFinite = typeof PositiveFiniteSchema.Type;

export const PositiveIntegerSchema = PositiveFiniteSchema.check(Schema.isInt());
export type PositiveInteger = typeof PositiveIntegerSchema.Type;

export const NonNegativeFiniteSchema = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
export type NonNegativeFinite = typeof NonNegativeFiniteSchema.Type;

export const NonNegativeIntegerSchema = NonNegativeFiniteSchema.check(Schema.isInt());
export type NonNegativeInteger = typeof NonNegativeIntegerSchema.Type;

export const Sha256Schema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export type Sha256 = typeof Sha256Schema.Type;

export const SafePathComponentSchema = Schema.NonEmptyString.check(
  Schema.isMaxLength(255),
  Schema.isPattern(/^[^/\\\\]+$/),
  Schema.makeFilter((value) => {
    if (value === "." || value === "..") return "Path components cannot be dot segments";
    if (
      [...value].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 31 || (code >= 127 && code <= 159);
      })
    )
      return "Path components must contain only printable characters";
  }),
);
export type SafePathComponent = typeof SafePathComponentSchema.Type;
