import { Schema } from "effect";
import { PositiveFiniteSchema, PositiveIntegerSchema } from "./common-contracts.ts";
import { FrameIndexSchema, MediaPositionSchema } from "./media-position.ts";

export const TrimRangeSchema = Schema.Struct({
  start: MediaPositionSchema,
  end: Schema.optionalKey(MediaPositionSchema),
});
export type TrimRange = typeof TrimRangeSchema.Type;

const TimestampTicksSchema = Schema.String.check(Schema.isPattern(/^-?(?:0|[1-9]\d*)$/));
export const ResolvedTrimRangeSchema = Schema.Struct({
  videoStreamIndex: FrameIndexSchema,
  startFrame: FrameIndexSchema,
  endFrame: FrameIndexSchema,
  frameCount: PositiveIntegerSchema,
  startPts: TimestampTicksSchema,
  endPts: TimestampTicksSchema,
  timeBase: Schema.Struct({ numerator: PositiveIntegerSchema, denominator: PositiveIntegerSchema }),
  durationSeconds: PositiveFiniteSchema,
}).check(
  Schema.makeFilter((range) => {
    if (
      range.endFrame - range.startFrame !== range.frameCount ||
      BigInt(range.endPts) <= BigInt(range.startPts)
    )
      return "Resolved trim must contain a positive frame range and timeline interval";
  }),
);
export type ResolvedTrimRange = typeof ResolvedTrimRangeSchema.Type;
