import type { TrimRange } from "@densio/shared";
import { Schema, Result } from "effect";
import { positionTime, secondsToTicks } from "./trim-position.ts";
import { TrimRangeInvalid, TrimTimelineUnsupported } from "./trim-errors.ts";

const TickSchema = Schema.String.check(Schema.isPattern(/^-?\d+$/));
const FrameSchema = Schema.Struct({
  pts: Schema.optionalKey(TickSchema),
  best_effort_timestamp: Schema.optionalKey(TickSchema),
  duration: Schema.optionalKey(TickSchema),
  pkt_duration: Schema.optionalKey(TickSchema),
});
const decodeFrame = Schema.decodeUnknownSync(FrameSchema);

export const makeTrimFrameScanner = (
  range: TrimRange,
  timeBase: { numerator: number; denominator: number },
  observeFrame?: (frame: number, pts: bigint) => void,
) => {
  const state = {
    buffer: "",
    count: 0,
    origin: undefined as bigint | undefined,
    last: undefined as bigint | undefined,
    duration: 0n,
    start: undefined as { frame: number; pts: bigint } | undefined,
    end: undefined as { frame: number; pts: bigint } | undefined,
    error: undefined as unknown,
  };
  const startTime = positionTime(range.start);
  const endTime = range.end === undefined ? undefined : positionTime(range.end);
  const consume = (line: string) => {
    if (!line.startsWith("frame|")) return;
    const fields = Object.fromEntries(
      line
        .split("|")
        .slice(1)
        .map((field) => field.split("="))
        .filter(([, value]) => value !== "N/A"),
    );
    const frame = decodeFrame(fields);
    const value = frame.best_effort_timestamp ?? frame.pts;
    if (value === undefined) throw unsupported();
    const pts = BigInt(value);
    if (state.last !== undefined && pts <= state.last) throw unsupported();
    state.origin ??= pts;
    const startReached =
      range.start.kind === "frame"
        ? state.count === range.start.frame
        : pts >= state.origin + secondsToTicks(startTime!, timeBase);
    const endReached =
      range.end?.kind === "frame"
        ? state.count === range.end.frame
        : endTime !== undefined && pts >= state.origin + secondsToTicks(endTime, timeBase);
    if (startReached && state.start === undefined) state.start = { frame: state.count, pts };
    if (endReached && state.end === undefined) state.end = { frame: state.count, pts };
    observeFrame?.(state.count, pts);
    state.last = pts;
    state.duration = BigInt(frame.duration ?? frame.pkt_duration ?? "0");
    state.count += 1;
  };
  const push = (chunk: string) => {
    if (state.error !== undefined) return;
    // Process callbacks cannot throw into the child-process event loop.
    const result = Result.try(() => {
      const lines = (state.buffer + chunk).split("\n");
      state.buffer = lines.pop() ?? "";
      if (state.buffer.length > 4096) throw unsupported();
      lines.forEach(consume);
    });
    state.error = Result.isFailure(result) ? result.failure : undefined;
  };
  const finish = (streamEnd?: bigint) => {
    if (state.error !== undefined) throw state.error;
    if (state.buffer) consume(state.buffer);
    if (state.last === undefined || state.origin === undefined) throw unsupported();
    const eof = state.duration > 0n ? state.last + state.duration : streamEnd;
    if (eof === undefined || eof <= state.last) throw unsupported();
    const end =
      state.end ??
      (range.end === undefined ||
      (range.end.kind === "frame" && range.end.frame === state.count) ||
      (endTime !== undefined && state.origin + secondsToTicks(endTime, timeBase) <= eof)
        ? { frame: state.count, pts: eof }
        : undefined);
    const start = state.start;
    if (!start || !end || start.frame >= end.frame)
      throw new TrimRangeInvalid({
        message: "Trim bounds must select a nonempty range within the video.",
      });
    return {
      startFrame: start.frame,
      endFrame: end.frame,
      frameCount: end.frame - start.frame,
      startPts: String(start.pts),
      endPts: String(end.pts),
      durationSeconds: (Number(end.pts - start.pts) * timeBase.numerator) / timeBase.denominator,
    };
  };
  return { push, finish };
};

const unsupported = () =>
  new TrimTimelineUnsupported({ message: "The video has missing or inconsistent frame timing." });
