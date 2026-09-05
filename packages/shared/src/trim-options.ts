import { Schema } from "effect";
import { Av1CrfSchema, H265CrfSchema, Vp9CrfSchema } from "./media-options.ts";
import { ResolvedTrimRangeSchema, TrimRangeSchema } from "./trim-range.ts";

const OutputSchema = Schema.Union([
  Schema.Struct({ codec: Schema.Literal("vp9"), crf: Schema.optionalKey(Vp9CrfSchema) }),
  Schema.Struct({ codec: Schema.Literal("h265"), crf: Schema.optionalKey(H265CrfSchema) }),
  Schema.Struct({ codec: Schema.Literal("av1"), crf: Schema.optionalKey(Av1CrfSchema) }),
]);
const ResolvedOutputSchema = Schema.Union([
  Schema.Struct({ codec: Schema.Literal("vp9"), crf: Vp9CrfSchema }),
  Schema.Struct({ codec: Schema.Literal("h265"), crf: H265CrfSchema }),
  Schema.Struct({ codec: Schema.Literal("av1"), crf: Av1CrfSchema }),
]);
export const TrimOptionsSchema = Schema.Struct({
  trim: TrimRangeSchema,
  output: OutputSchema,
  audio: Schema.optionalKey(Schema.Literals(["keep", "remove"])),
});
export type TrimOptions = typeof TrimOptionsSchema.Type;
export const ResolvedTrimOptionsSchema = Schema.Struct({
  trim: ResolvedTrimRangeSchema,
  output: ResolvedOutputSchema,
  audio: Schema.Literals(["keep", "remove"]),
});
export type ResolvedTrimOptions = typeof ResolvedTrimOptionsSchema.Type;
