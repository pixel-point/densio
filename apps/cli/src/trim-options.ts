import { MediaPositionSchema, TrimOptionsSchema, TrimRangeSchema } from "@densio/shared";
import {
  decodeCliOptions,
  numberFlag,
  singleFlag,
  type ParsedCommandArguments,
} from "./command-options.ts";
import { CliUsageError } from "./cli-errors.ts";

export const parseTrimRange = (parsed: ParsedCommandArguments) => {
  const start = singleFlag(parsed, "--trim-start");
  const end = singleFlag(parsed, "--trim-end");
  if (start === undefined && end === undefined) return undefined;
  if (start === undefined) throw new CliUsageError("--trim-end requires --trim-start.");
  return decodeCliOptions(
    TrimRangeSchema,
    {
      start: parseMediaPosition(start),
      ...(end === undefined ? {} : { end: parseMediaPosition(end) }),
    },
    "trim",
  );
};

export const parseTrimOptions = (parsed: ParsedCommandArguments) => {
  const codec = singleFlag(parsed, "--codec");
  const trim = parseTrimRange(parsed);
  if (!trim) throw new CliUsageError("Standalone trimming requires --trim-start.");
  if (codec !== "vp9" && codec !== "h265" && codec !== "av1")
    throw new CliUsageError("Standalone trimming requires exactly one --codec: vp9, h265, or av1.");
  if (
    ["vp9", "h265", "av1"].some(
      (candidate) => candidate !== codec && parsed.flags.has(`--${candidate}-crf`),
    )
  )
    throw new CliUsageError("Only the selected codec's CRF may be specified for trimming.");
  const crf = numberFlag(parsed, `--${codec}-crf`);
  const audio = singleFlag(parsed, "--audio");
  return decodeCliOptions(
    TrimOptionsSchema,
    {
      trim,
      output: { codec, ...(crf === undefined ? {} : { crf }) },
      ...(audio === undefined ? {} : { audio }),
    },
    "trim",
  );
};

const parseMediaPosition = (value: string) =>
  decodeCliOptions(
    MediaPositionSchema,
    /^frame:\d+$/.test(value)
      ? { kind: "frame", frame: Number(value.slice(6)) }
      : Number.isFinite(Number(value)) && value.trim() !== ""
        ? { kind: "seconds", seconds: Number(value) }
        : { kind: "timecode", timecode: value },
    "trim position",
  );
