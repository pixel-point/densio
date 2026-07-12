import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decodeMediaProbe } from "../src/media/inspection/media-probe.ts";

const validProbe = {
  format: { duration: "12.500000" },
  streams: [
    {
      index: 0,
      codec_name: "hevc",
      codec_type: "video",
      width: 1080,
      height: 1920,
      avg_frame_rate: "30000/1001",
      r_frame_rate: "30/1",
      side_data_list: [{ rotation: -90 }],
    },
    { index: 1, codec_name: "aac", codec_type: "audio" },
    { index: 2, codec_name: "subrip", codec_type: "subtitle" },
  ],
};

describe("media probe decoding", () => {
  it("decodes duration, dimensions, rotation, frame rate, and every stream", async () => {
    const media = await Effect.runPromise(decodeMediaProbe(JSON.stringify(validProbe)));

    expect(media).toEqual({
      audioStreamIndexes: [1],
      displayDimensions: { height: 1080, width: 1920 },
      durationSeconds: 12.5,
      encodedDimensions: { height: 1920, width: 1080 },
      frameRate: {
        denominator: 1001,
        framesPerSecond: 30000 / 1001,
        numerator: 30000,
      },
      rotationDegrees: 270,
      streams: [
        { codecName: "hevc", index: 0, type: "video" },
        { codecName: "aac", index: 1, type: "audio" },
        { codecName: "subrip", index: 2, type: "subtitle" },
      ],
      videoStreamIndex: 0,
    });
  });

  it.each(["not json", "{}", JSON.stringify({ format: {}, streams: [] })])(
    "rejects malformed or non-video probe output",
    async (output) => {
      const error = await Effect.runPromise(Effect.flip(decodeMediaProbe(output)));

      expect(error).toMatchObject({ _tag: "MediaInspectionError" });
    },
  );

  it("rejects an attached cover image as the only video stream", async () => {
    const output = JSON.stringify({
      format: { duration: "4" },
      streams: [
        {
          index: 0,
          codec_type: "video",
          codec_name: "mjpeg",
          width: 400,
          height: 400,
          avg_frame_rate: "0/0",
          disposition: { attached_pic: 1 },
        },
        { index: 1, codec_type: "audio", codec_name: "mp3" },
      ],
    });

    const error = await Effect.runPromise(Effect.flip(decodeMediaProbe(output)));

    expect(error).toMatchObject({ reason: "no-video-stream" });
  });
});
