import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  CompareQualityOptionsSchema,
  ComparisonPositionSchema,
  CompressionOptionsSchema,
  ExtractImagesOptionsSchema,
} from "../src/index.ts";

describe("compression options", () => {
  it("accepts codec CRFs, automatic audio, crop, and proportional scaling", () => {
    const options = {
      codecs: ["vp9", "h265"],
      crf: { vp9: 40, h265: 32 },
      audio: "auto",
      transform: {
        crop: { kind: "aspect-ratio", aspectRatio: "16:9" },
        scale: { width: 1280 },
      },
    };

    expect(Schema.decodeUnknownSync(CompressionOptionsSchema)(options)).toEqual(options);
  });

  it("rejects unsupported codecs and out-of-range CRFs", () => {
    const decode = Schema.decodeUnknownSync(CompressionOptionsSchema);

    expect(() => decode({ codecs: ["h264"] })).toThrow();
    expect(() => decode({ crf: { h265: 52 } })).toThrow();
  });

  it("requires scaling by exactly one positive dimension", () => {
    const decode = Schema.decodeUnknownSync(CompressionOptionsSchema);

    expect(() => decode({ transform: { scale: { width: 0 } } })).toThrow();
    expect(() => decode({ transform: { scale: { width: 1280, height: 720 } } })).toThrow();
  });

  it("rejects invalid crop geometry", () => {
    const decode = Schema.decodeUnknownSync(CompressionOptionsSchema);

    expect(() =>
      decode({ transform: { crop: { kind: "aspect-ratio", aspectRatio: "16/9" } } }),
    ).toThrow();
    expect(() =>
      decode({
        transform: {
          crop: { kind: "rectangle", width: 640, height: 360, x: -1, y: 0 },
        },
      }),
    ).toThrow();
  });
});

describe("comparison options", () => {
  it.each([
    { kind: "seconds", seconds: 83.5 },
    { kind: "timecode", timecode: "01:23.500" },
    { kind: "timecode", timecode: "00:01:23.500" },
    { kind: "frame", frame: 120 },
  ])("accepts the $kind position", (position) => {
    expect(Schema.decodeUnknownSync(ComparisonPositionSchema)(position)).toEqual(position);
  });

  it("accepts two to eight unique CRFs and a one-to-three second sample", () => {
    const options = {
      codec: "vp9",
      crfs: [28, 36, 44],
      durationSeconds: 3,
      position: { kind: "seconds", seconds: 0 },
    };

    expect(Schema.decodeUnknownSync(CompareQualityOptionsSchema)(options)).toEqual(options);
  });

  it("rejects invalid positions, duplicate CRFs, and long samples", () => {
    const decodePosition = Schema.decodeUnknownSync(ComparisonPositionSchema);
    const decodeOptions = Schema.decodeUnknownSync(CompareQualityOptionsSchema);

    expect(() => decodePosition({ kind: "timecode", timecode: "01:75:00" })).toThrow();
    expect(() => decodePosition({ kind: "frame", frame: 1.5 })).toThrow();
    expect(() => decodeOptions({ codec: "vp9", crfs: [30, 30] })).toThrow();
    expect(() => decodeOptions({ codec: "vp9", crfs: [30, 40], durationSeconds: 3.01 })).toThrow();
  });
});

describe("image extraction options", () => {
  it("accepts fractional intervals and supported image formats", () => {
    const options = { intervalSeconds: 0.25, format: "webp" };

    expect(Schema.decodeUnknownSync(ExtractImagesOptionsSchema)(options)).toEqual(options);
  });

  it("rejects zero intervals and unsupported formats", () => {
    const decode = Schema.decodeUnknownSync(ExtractImagesOptionsSchema);

    expect(() => decode({ intervalSeconds: 0 })).toThrow();
    expect(() => decode({ format: "gif" })).toThrow();
  });
});
