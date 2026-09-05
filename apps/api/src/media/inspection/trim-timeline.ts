import { ResolvedTrimRangeSchema, TrimRangeSchema, type TrimRange } from "@densio/shared";
import { Effect, Schema } from "effect";
import { MediaProcessRunner } from "../process/media-process-runner.ts";
import { MediaInspectionError } from "./media-inspection-error.ts";
import { TrimRangeInvalid, TrimTimelineUnsupported } from "./trim-errors.ts";
import { makeTrimFrameScanner } from "./trim-frame-scanner.ts";

const StreamSchema = Schema.Struct({
  streams: Schema.Array(
    Schema.Struct({
      time_base: Schema.String.check(Schema.isPattern(/^[1-9]\d*\/[1-9]\d*$/)),
      start_pts: Schema.optionalKey(Schema.Int),
      duration_ts: Schema.optionalKey(Schema.Int),
    }),
  ),
});

export const resolveTrimRange = Effect.fn("TrimTimeline.resolve")(function* (
  executable: string,
  inputPath: string,
  requested: TrimRange,
  videoStreamIndex: number,
  observeFrame?: (frame: number, pts: bigint) => void,
) {
  const range = yield* Schema.decodeUnknownEffect(TrimRangeSchema)(requested).pipe(
    Effect.mapError(() => new TrimRangeInvalid({ message: "Trim positions are invalid." })),
  );
  const runner = yield* MediaProcessRunner;
  const metadata = yield* runner.run({
    executable,
    arguments: [
      "-v",
      "error",
      "-select_streams",
      String(videoStreamIndex),
      "-show_streams",
      "-show_entries",
      "stream=time_base,start_pts,duration_ts",
      "-of",
      "json",
      inputPath,
    ],
  });
  if (metadata.stdoutTruncated) return yield* malformedTimeline();
  const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StreamSchema))(
    metadata.stdout,
  ).pipe(Effect.mapError(malformedTimeline));
  const stream = decoded.streams[0];
  if (stream === undefined) return yield* malformedTimeline();
  const [numerator = 0, denominator = 0] = stream.time_base.split("/").map(Number);
  if (![numerator, denominator].every(Number.isSafeInteger)) return yield* malformedTimeline();
  const timeBase = { numerator, denominator };
  const scanner = makeTrimFrameScanner(range, timeBase, observeFrame);
  yield* runner.run({
    executable,
    arguments: [
      "-v",
      "error",
      "-select_streams",
      String(videoStreamIndex),
      "-show_frames",
      "-show_entries",
      "frame=pts,best_effort_timestamp,duration,pkt_duration",
      "-of",
      "compact",
      inputPath,
    ],
    stdoutObserver: scanner.push,
  });
  const endpoint =
    Number.isSafeInteger(stream.duration_ts) && Number.isSafeInteger(stream.start_pts)
      ? BigInt(stream.start_pts!) + BigInt(stream.duration_ts!)
      : undefined;
  const resolved = yield* Effect.try({
    try: () => scanner.finish(endpoint),
    catch: (error) => error,
  });
  return yield* Schema.decodeUnknownEffect(ResolvedTrimRangeSchema)({
    ...resolved,
    videoStreamIndex,
    timeBase,
  }).pipe(Effect.mapError(malformedTimeline));
});

const malformedTimeline = () =>
  new MediaInspectionError({
    message: "FFprobe returned malformed trim timeline data.",
    reason: "invalid-probe-output",
  });
export { TrimRangeInvalid, TrimTimelineUnsupported };
