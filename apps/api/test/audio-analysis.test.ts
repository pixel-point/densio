import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  buildAudioAnalysisCommand,
  decodeAudioAnalysis,
} from "../src/media/inspection/audio-analysis.ts";

const peak = (value: string) => `lavfi.astats.Overall.Peak_level=${value}\n`;

describe("audio analysis command", () => {
  it("analyzes one complete stream and writes machine-delimited peaks to stdout", () => {
    const command = buildAudioAnalysisCommand("/tmp/input;safe.mp4", 3, "/opt/ffmpeg/ffmpeg");

    expect(command).toEqual({
      executable: "/opt/ffmpeg/ffmpeg",
      arguments: [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-i",
        "/tmp/input;safe.mp4",
        "-map",
        "0:3",
        "-vn",
        "-sn",
        "-dn",
        "-af",
        "astats=metadata=1:reset=0,ametadata=mode=print:key=lavfi.astats.Overall.Peak_level:file=pipe\\:1:direct=1",
        "-f",
        "null",
        "-",
      ],
    });
    expect(command.arguments).not.toContain("-t");
    expect(command.arguments).not.toContain("-shortest");
  });
});

describe("audio analysis decoding", () => {
  it("classifies media without audio streams as absent", async () => {
    await expect(Effect.runPromise(decodeAudioAnalysis([]))).resolves.toBe("absent");
  });

  it("classifies all tracks at or below -50 dBFS as silent", async () => {
    const outputs = [peak("-inf") + peak("-50.000000"), peak("-72.4")];

    await expect(Effect.runPromise(decodeAudioAnalysis(outputs))).resolves.toBe("silent");
  });

  it("classifies media as audible when any track exceeds the threshold", async () => {
    const outputs = [peak("-80"), peak("-49.999")];

    await expect(Effect.runPromise(decodeAudioAnalysis(outputs))).resolves.toBe("audible");
  });

  it("uses a caller-provided dBFS threshold", async () => {
    await expect(Effect.runPromise(decodeAudioAnalysis([peak("-30")], -20))).resolves.toBe(
      "silent",
    );
    await expect(Effect.runPromise(decodeAudioAnalysis([peak("-30")], -40))).resolves.toBe(
      "audible",
    );
  });

  it.each([[""], ["unrelated=value\n"], [peak("NaN")]])(
    "rejects incomplete audio analysis output",
    async (output) => {
      const error = await Effect.runPromise(Effect.flip(decodeAudioAnalysis([output])));

      expect(error).toMatchObject({ reason: "invalid-audio-analysis" });
    },
  );
});
