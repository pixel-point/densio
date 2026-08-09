import { MEDIA_CODECS } from "@ffmpeg-api/shared";
import { Effect } from "effect";

import { MEDIA_CODEC_EXECUTION_POLICY } from "../codec-execution-policy.ts";
import { MediaInspectionError } from "./media-inspection-error.ts";

const requiredEncoders = MEDIA_CODECS.map((codec) => MEDIA_CODEC_EXECUTION_POLICY[codec].encoder);

export interface MediaCapabilities {
  readonly encoders: ReadonlyArray<(typeof requiredEncoders)[number]>;
  readonly ffmpegVersion: string;
  readonly ffprobeVersion: string;
}

export const decodeMediaCapabilities = Effect.fn("decodeMediaCapabilities")(function* (
  ffmpegOutput: string,
  ffprobeOutput: string,
  encoderOutput: string,
) {
  const ffmpegVersion = binaryVersion(ffmpegOutput, "ffmpeg");
  const ffprobeVersion = binaryVersion(ffprobeOutput, "ffprobe");
  const encoders = encoderNames(encoderOutput);
  if (ffmpegVersion === undefined || ffprobeVersion === undefined || encoders.length === 0) {
    return yield* capabilityError(
      "invalid-capability-output",
      "FFmpeg or FFprobe returned malformed capability output.",
    );
  }

  const missing = requiredEncoders.filter((encoder) => !encoders.includes(encoder));
  if (missing.length > 0) {
    return yield* capabilityError(
      "missing-required-encoder",
      `FFmpeg is missing required encoders: ${missing.join(", ")}.`,
    );
  }

  return { encoders: requiredEncoders, ffmpegVersion, ffprobeVersion };
});

const binaryVersion = (output: string, binary: "ffmpeg" | "ffprobe") =>
  output.match(new RegExp(`^${binary} version ([^\\s]+)`, "mu"))?.[1];

const encoderNames = (output: string) =>
  output.split(/\r?\n/u).flatMap((line) => {
    const name = line.match(/^\s*V[.A-Z]{5}\s+(\S+)(?:\s|$)/u)?.[1];
    return name === undefined || name === "=" ? [] : [name];
  });

const capabilityError = (
  reason: "invalid-capability-output" | "missing-required-encoder",
  message: string,
) => new MediaInspectionError({ message, reason });
