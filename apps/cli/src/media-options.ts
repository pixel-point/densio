import { parseTrimRange } from "./trim-options.ts";
import {
  CompareQualityOptionsSchema,
  CompressionOptionsSchema,
  ExtractImagesOptionsSchema,
} from "@densio/shared";

import {
  buildTransformOptions,
  commaSeparatedFlags,
  decodeCliOptions,
  numberFlag,
  type ParsedCommandArguments,
  singleFlag,
} from "./command-options.ts";
import { CliUsageError } from "./cli-errors.ts";

export const parseCompressionOptions = (parsed: ParsedCommandArguments) => {
  const bitDepth = numberFlag(parsed, "--bit-depth");
  const trim = parseTrimRange(parsed);
  const codecs = commaSeparatedFlags(parsed, "--codec");
  const crf = compactRecord({
    av1: numberFlag(parsed, "--av1-crf"),
    h265: numberFlag(parsed, "--h265-crf"),
    vp9: numberFlag(parsed, "--vp9-crf"),
  });
  const transform = buildTransformOptions(parsed);
  const frameRate = compressionFrameRate(singleFlag(parsed, "--frame-rate"));
  const options = decodeCliOptions(
    CompressionOptionsSchema,
    {
      ...(bitDepth === undefined ? {} : { bitDepth }),
      ...(codecs.length === 0 ? {} : { codecs }),
      ...(trim === undefined ? {} : { trim }),
      ...(Object.keys(crf).length === 0 ? {} : { crf }),
      ...(singleFlag(parsed, "--audio") === undefined
        ? {}
        : { audio: singleFlag(parsed, "--audio") }),
      ...(frameRate === undefined ? {} : { frameRate }),
      ...(transform === undefined ? {} : { transform }),
    },
    "compress",
  );

  return options;
};

export const parseExtractionOptions = (parsed: ParsedCommandArguments) => {
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
  return options;
};

export const parseComparisonOptions = (parsed: ParsedCommandArguments) => {
  const bitDepth = numberFlag(parsed, "--bit-depth");
  const automaticSamples = numberFlag(parsed, "--samples");
  const explicitSamples = parsed.flags.get("--sample") ?? [];
  if (automaticSamples !== undefined && explicitSamples.length > 0) {
    throw new CliUsageError("Use only one of --samples or --sample.");
  }
  const transform = buildTransformOptions(parsed);
  const durationSeconds = numberFlag(parsed, "--sample-duration");
  return decodeCliOptions(
    CompareQualityOptionsSchema,
    {
      ...(bitDepth === undefined ? {} : { bitDepth }),
      ...(parsed.flags.has("--metric")
        ? { objectiveMetrics: commaSeparatedFlags(parsed, "--metric") }
        : {}),
      variants: (parsed.flags.get("--matrix") ?? []).flatMap(parseMatrixVariants),
      ...(automaticSamples === undefined
        ? explicitSamples.length === 0
          ? {}
          : { samples: { mode: "positions", positions: explicitSamples.map(parseSamplePosition) } }
        : { samples: { count: automaticSamples, mode: "auto" } }),
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
      ...(transform === undefined ? {} : { transform }),
    },
    "compare-quality",
  );
};

const parseMatrixVariants = (value: string) => {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1 || value.indexOf(":", separator + 1) >= 0) {
    throw new CliUsageError("--matrix must use CODEC:CRF,CRF.");
  }
  const codec = value.slice(0, separator);
  return value
    .slice(separator + 1)
    .split(",")
    .map((crf) => {
      if (crf.trim() === "")
        throw new CliUsageError("--matrix requires a CRF for every candidate.");
      return { codec, crf: Number(crf) };
    });
};

const parseSamplePosition = (value: string) => {
  if (value.startsWith("frame:")) {
    return { frame: Number(value.slice("frame:".length)), kind: "frame" as const };
  }
  const seconds = Number(value);
  return Number.isFinite(seconds)
    ? { kind: "seconds" as const, seconds }
    : { kind: "timecode" as const, timecode: value };
};

const compactRecord = (record: Readonly<Record<string, number | undefined>>) =>
  Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, number] => entry[1] !== undefined),
  );

const compressionFrameRate = (value: string | undefined) => {
  if (value === undefined) return undefined;
  if (value === "preserve") return { mode: "preserve" as const };
  if (value === "cap-30") return { maximum: 30 as const, mode: "cap" as const };
  throw new CliUsageError("--frame-rate must be preserve or cap-30.");
};
