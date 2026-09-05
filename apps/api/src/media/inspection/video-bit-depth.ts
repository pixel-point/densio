import type { MediaBitDepth } from "@densio/shared";
import { Effect, Schema } from "effect";
import { MediaProcessRunner } from "../process/media-process-runner.ts";
import { MediaInspectionError } from "./media-inspection-error.ts";

const PixelFormatProbeSchema = Schema.fromJsonString(
  Schema.Struct({
    streams: Schema.Array(Schema.Struct({ pix_fmt: Schema.String })).check(
      Schema.isLengthBetween(1, 1),
    ),
  }),
);

export const verifyVideoBitDepth = Effect.fn("MediaInspection.verifyVideoBitDepth")(function* (
  executable: string,
  path: string,
  bitDepth: MediaBitDepth,
) {
  const runner = yield* MediaProcessRunner;
  const result = yield* runner.run({
    executable,
    arguments: [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=pix_fmt",
      "-of",
      "json",
      path,
    ],
  });
  const invalid = new MediaInspectionError({
    reason: "output-bit-depth-mismatch",
    message: `The encoded video could not be verified as ${bitDepth}-bit 4:2:0. No output was published.`,
  });
  if (result.stdoutTruncated) return yield* invalid;
  const probe = yield* Schema.decodeUnknownEffect(PixelFormatProbeSchema)(result.stdout).pipe(
    Effect.mapError(() => invalid),
  );
  const expected = bitDepth === 10 ? "yuv420p10le" : "yuv420p";
  if (probe.streams[0]?.pix_fmt !== expected) return yield* invalid;
});
