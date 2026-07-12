import { Schema } from "effect";

export class MediaInspectionError extends Schema.TaggedErrorClass<MediaInspectionError>()(
  "MediaInspectionError",
  {
    message: Schema.String,
    reason: Schema.Literals([
      "codec-not-entitled",
      "duration-limit-exceeded",
      "frame-out-of-range",
      "invalid-audio-analysis",
      "invalid-frame-index",
      "invalid-frame-output",
      "invalid-capability-output",
      "invalid-probe-output",
      "invalid-video-metadata",
      "missing-required-encoder",
      "no-video-stream",
      "truncated-process-output",
    ]),
  },
) {}
