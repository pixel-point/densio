import { Effect } from "effect";

import type { MediaProcessCommand } from "../process/media-process-runner.ts";
import { MediaInspectionError } from "./media-inspection-error.ts";

export type AudioClassification = "absent" | "silent" | "audible";

const peakMetadataKey = "lavfi.astats.Overall.Peak_level";
const peakFilter =
  `astats=metadata=1:reset=0,ametadata=mode=print:key=${peakMetadataKey}` +
  ":file=pipe\\:1:direct=1";

export const buildAudioAnalysisCommand = (
  inputPath: string,
  streamIndex: number,
  executable = "ffmpeg",
): MediaProcessCommand => ({
  executable,
  arguments: [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-i",
    inputPath,
    "-map",
    `0:${streamIndex}`,
    "-vn",
    "-sn",
    "-dn",
    "-af",
    peakFilter,
    "-f",
    "null",
    "-",
  ],
});

export const decodeAudioAnalysis = Effect.fn("decodeAudioAnalysis")(function* (
  outputs: ReadonlyArray<string>,
  silenceThresholdDb = -50,
) {
  if (outputs.length === 0) return "absent" as const;
  const trackPeaks = outputs.map(decodeTrackPeaks);
  if (trackPeaks.some((peaks) => peaks.length === 0)) {
    return yield* invalidAudioAnalysis();
  }

  const peak = Math.max(...trackPeaks.flat());
  if (!Number.isFinite(peak) && peak !== Number.NEGATIVE_INFINITY) {
    return yield* invalidAudioAnalysis();
  }

  return peak > silenceThresholdDb ? ("audible" as const) : ("silent" as const);
});

const decodeTrackPeaks = (output: string) =>
  output
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(`${peakMetadataKey}=`))
    .flatMap((line) => {
      const value = line.slice(peakMetadataKey.length + 1).trim();
      const peak = value === "-inf" ? Number.NEGATIVE_INFINITY : Number(value);
      return Number.isFinite(peak) || peak === Number.NEGATIVE_INFINITY ? [peak] : [];
    });

const invalidAudioAnalysis = () =>
  new MediaInspectionError({
    message: "FFmpeg returned incomplete audio level metadata.",
    reason: "invalid-audio-analysis",
  });
