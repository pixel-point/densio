import {
  CompareQualityOptionsSchema,
  CompressionOptionsSchema,
  ExtractImagesOptionsSchema,
} from "@densio/shared";

import {
  buildTransformOptions,
  commaSeparatedFlags,
  commonMediaBooleanFlags,
  commonMediaValueFlags,
  decodeCliOptions,
  numberFlag,
  parseCommandArguments,
  requireSinglePositional,
  singleFlag,
} from "./command-options.ts";
import { CliUsageError } from "./cli-errors.ts";

export interface ParsedMediaCommand<Options> {
  readonly idempotencyKey?: string;
  readonly inputPath: string;
  readonly noWait: boolean;
  readonly options: Options;
  readonly timeoutSeconds?: number;
}

export const parseCompressionCommand = (argv: ReadonlyArray<string>) => {
  const parsed = parseCommandArguments(
    argv,
    new Set([
      ...commonMediaValueFlags,
      "--audio",
      "--av1-crf",
      "--codec",
      "--h265-crf",
      "--vp9-crf",
    ]),
    commonMediaBooleanFlags,
  );
  const codecs = commaSeparatedFlags(parsed, "--codec");
  const crf = compactRecord({
    av1: numberFlag(parsed, "--av1-crf"),
    h265: numberFlag(parsed, "--h265-crf"),
    vp9: numberFlag(parsed, "--vp9-crf"),
  });
  const transform = buildTransformOptions(parsed);
  const options = decodeCliOptions(
    CompressionOptionsSchema,
    {
      ...(codecs.length === 0 ? {} : { codecs }),
      ...(Object.keys(crf).length === 0 ? {} : { crf }),
      ...(singleFlag(parsed, "--audio") === undefined
        ? {}
        : { audio: singleFlag(parsed, "--audio") }),
      ...(transform === undefined ? {} : { transform }),
    },
    "compress",
  );

  return mediaCommand(parsed, options, "compress requires exactly one video path.");
};

export const parseExtractionCommand = (argv: ReadonlyArray<string>) => {
  const parsed = parseCommandArguments(
    argv,
    new Set([...commonMediaValueFlags, "--format", "--interval"]),
    commonMediaBooleanFlags,
  );
  const transform = buildTransformOptions(parsed);
  const options = decodeCliOptions(
    ExtractImagesOptionsSchema,
    {
      ...(singleFlag(parsed, "--format") === undefined
        ? {}
        : { format: singleFlag(parsed, "--format") }),
      ...(numberFlag(parsed, "--interval") === undefined
        ? {}
        : { intervalSeconds: numberFlag(parsed, "--interval") }),
      ...(transform === undefined ? {} : { transform }),
    },
    "extract-images",
  );
  return mediaCommand(parsed, options, "extract-images requires exactly one video path.");
};

export const parseComparisonCommand = (argv: ReadonlyArray<string>) => {
  const parsed = parseCommandArguments(
    argv,
    new Set([...commonMediaValueFlags, "--at", "--codec", "--crf", "--duration", "--frame"]),
    commonMediaBooleanFlags,
  );
  const crfs = commaSeparatedFlags(parsed, "--crf").map(Number);
  const codec = singleFlag(parsed, "--codec") ?? "vp9";
  const transform = buildTransformOptions(parsed);
  const position = comparisonPosition(parsed);
  const options = decodeCliOptions(
    CompareQualityOptionsSchema,
    {
      codec,
      crfs,
      ...(numberFlag(parsed, "--duration") === undefined
        ? {}
        : { durationSeconds: numberFlag(parsed, "--duration") }),
      ...(position === undefined ? {} : { position }),
      ...(transform === undefined ? {} : { transform }),
    },
    "compare-quality",
  );
  return mediaCommand(parsed, options, "compare-quality requires exactly one video path.");
};

const mediaCommand = <Options>(
  parsed: Parameters<typeof requireSinglePositional>[0],
  options: Options,
  usage: string,
): ParsedMediaCommand<Options> => {
  const idempotencyKey = singleFlag(parsed, "--idempotency-key");
  const timeoutSeconds = numberFlag(parsed, "--timeout");
  if (timeoutSeconds !== undefined && timeoutSeconds <= 0) {
    throw new CliUsageError("--timeout must be positive.");
  }
  return {
    inputPath: requireSinglePositional(parsed, usage),
    noWait: parsed.switches.has("--no-wait"),
    options,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
  };
};

const comparisonPosition = (parsed: Parameters<typeof singleFlag>[0]) => {
  const at = singleFlag(parsed, "--at");
  const frame = numberFlag(parsed, "--frame");
  if (at !== undefined && frame !== undefined) {
    throw new CliUsageError("Use only one of --at or --frame.");
  }
  if (frame !== undefined) return { frame, kind: "frame" as const };
  if (at === undefined) return undefined;
  const seconds = Number(at);
  return Number.isFinite(seconds)
    ? { kind: "seconds" as const, seconds }
    : { kind: "timecode" as const, timecode: at };
};

const compactRecord = (record: Readonly<Record<string, number | undefined>>) =>
  Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, number] => entry[1] !== undefined),
  );
