import { Effect, Schema } from "effect";

import { MediaInspectionError } from "./media-inspection-error.ts";

const FrameSchema = Schema.Struct({
  best_effort_timestamp_time: Schema.optionalKey(Schema.String),
  pts_time: Schema.optionalKey(Schema.String),
});

const FramesOutputSchema = Schema.Struct({ frames: Schema.Array(FrameSchema) });
const decodeFramesOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(FramesOutputSchema));

export const decodeFrameTimestamp = Effect.fn("decodeFrameTimestamp")(function* (
  output: string,
  frameIndex: number,
) {
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) {
    return yield* frameError("invalid-frame-index", "Frame index must be a non-negative integer.");
  }

  const decoded = yield* decodeFramesOutput(output).pipe(
    Effect.mapError(() =>
      frameError("invalid-frame-output", "FFprobe returned malformed frame metadata."),
    ),
  );
  const frame = decoded.frames[frameIndex];
  if (frame === undefined) {
    return yield* frameError("frame-out-of-range", "The requested frame does not exist.");
  }

  const timestamp = Number(frame.best_effort_timestamp_time ?? frame.pts_time);
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    return yield* frameError("invalid-frame-output", "The requested frame has no valid timestamp.");
  }

  return timestamp;
});

const frameError = (reason: FrameErrorReason, message: string) =>
  new MediaInspectionError({ message, reason });

type FrameErrorReason = "frame-out-of-range" | "invalid-frame-index" | "invalid-frame-output";
