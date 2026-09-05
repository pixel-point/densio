import { Schema } from "effect";
import { NonNegativeFiniteSchema, NonNegativeIntegerSchema } from "./common-contracts.ts";
export const FrameIndexSchema = NonNegativeIntegerSchema.check(
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const SecondsPositionSchema = Schema.Struct({
  kind: Schema.Literal("seconds"),
  seconds: NonNegativeFiniteSchema,
});

const TimecodePositionSchema = Schema.Struct({
  kind: Schema.Literal("timecode"),
  timecode: Schema.String.check(Schema.isPattern(/^(?:\d{2}:)?[0-5]\d:[0-5]\d(?:\.\d{1,3})?$/)),
});

const FramePositionSchema = Schema.Struct({
  kind: Schema.Literal("frame"),
  frame: FrameIndexSchema,
});

export const MediaPositionSchema = Schema.Union([
  SecondsPositionSchema,
  TimecodePositionSchema,
  FramePositionSchema,
]);
export type MediaPosition = typeof MediaPositionSchema.Type;
