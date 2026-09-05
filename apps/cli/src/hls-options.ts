import { HlsOptionsSchema } from "@densio/shared";
import {
  decodeCliOptions,
  numberFlag,
  singleFlag,
  type ParsedCommandArguments,
} from "./command-options.ts";
import { CliUsageError } from "./cli-errors.ts";

export const parseHlsOptions = (parsed: ParsedCommandArguments) => {
  const crf = numberFlag(parsed, "--h265-crf");
  const audio = singleFlag(parsed, "--audio");
  const rateControl = singleFlag(parsed, "--rate-control");
  const frameRate = singleFlag(parsed, "--frame-rate");
  if (frameRate !== undefined && frameRate !== "preserve" && frameRate !== "cap-30")
    throw new CliUsageError("--frame-rate must be preserve or cap-30.");
  return decodeCliOptions(
    HlsOptionsSchema,
    {
      ...(crf === undefined ? {} : { crf: { h265: crf } }),
      ...(audio === undefined ? {} : { audio }),
      ...(rateControl === undefined ? {} : { rateControl: { mode: rateControl } }),
      ...(frameRate === undefined
        ? {}
        : {
            frameRate:
              frameRate === "preserve" ? { mode: "preserve" } : { mode: "cap", maximum: 30 },
          }),
    },
    "hls",
  );
};
