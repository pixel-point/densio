import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decodeMediaCapabilities } from "../src/media/inspection/media-capabilities.ts";

const encoders = `
Encoders:
 V..... = Video
 ------
 V....D libvpx-vp9          libvpx VP9
 V....D libx265             libx265 H.265 / HEVC
 V..... libsvtav1           SVT-AV1 encoder
 A..... aac                AAC encoder
`;

describe("media capabilities", () => {
  it("returns binary versions after finding every required encoder", async () => {
    const capabilities = await Effect.runPromise(
      decodeMediaCapabilities(
        "ffmpeg version 7.1.1-static Copyright FFmpeg developers\n",
        "ffprobe version 7.1.1-static Copyright FFmpeg developers\n",
        encoders,
      ),
    );

    expect(capabilities).toEqual({
      encoders: ["libvpx-vp9", "libx265", "libsvtav1"],
      ffmpegVersion: "7.1.1-static",
      ffprobeVersion: "7.1.1-static",
    });
  });

  it.each(["libsvtav1", "aac"])("fails closed when %s is absent", async (encoder) => {
    const error = await Effect.runPromise(
      Effect.flip(
        decodeMediaCapabilities(
          "ffmpeg version 7.1\n",
          "ffprobe version 7.1\n",
          encoders.replace(encoder, "missing"),
        ),
      ),
    );

    expect(error).toMatchObject({ reason: "missing-required-encoder" });
    expect(error.message).toContain(encoder);
  });

  it.each([
    ["unexpected", "ffprobe version 7.1", encoders],
    ["ffmpeg version 7.1", "unexpected", encoders],
    ["ffmpeg version 7.1", "ffprobe version 7.1", "libvpx-vp9 libx265 libsvtav1"],
  ])("rejects malformed capability output", async (ffmpeg, ffprobe, encoderOutput) => {
    const error = await Effect.runPromise(
      Effect.flip(decodeMediaCapabilities(ffmpeg, ffprobe, encoderOutput)),
    );

    expect(error).toMatchObject({ reason: "invalid-capability-output" });
  });
});
