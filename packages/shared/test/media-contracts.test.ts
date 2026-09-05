import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  CompareQualityOptionsSchema,
  ComparisonPositionSchema,
  CompressionOptionsSchema,
  ExtractImagesOptionsSchema,
} from "../src/index.ts";
import { CompareQualityResultSchema } from "../src/quality-comparison-results.ts";

describe("compression options", () => {
  it("accepts explicit source-preserve and 30 fps cap policies", () => {
    const decode = Schema.decodeUnknownSync(CompressionOptionsSchema);

    expect(decode({ frameRate: { mode: "preserve" } })).toEqual({
      frameRate: { mode: "preserve" },
    });
    expect(decode({ frameRate: { maximum: 30, mode: "cap" } })).toEqual({
      frameRate: { maximum: 30, mode: "cap" },
    });
  });

  it("rejects unsupported frame-rate policies", () => {
    const decode = Schema.decodeUnknownSync(CompressionOptionsSchema);

    expect(() => decode({ frameRate: { maximum: 60, mode: "cap" } })).toThrow();
    expect(() => decode({ frameRate: { mode: "convert" } })).toThrow();
  });

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
      variants: [
        { codec: "vp9", crf: 28 },
        { codec: "vp9", crf: 36 },
        { codec: "vp9", crf: 44 },
      ],
      durationSeconds: 3,
      samples: { mode: "positions", positions: [{ kind: "seconds", seconds: 0 }] },
    };

    expect(
      Schema.decodeUnknownSync(CompareQualityOptionsSchema, { onExcessProperty: "error" })(options),
    ).toEqual(options);
  });

  it("rejects invalid positions, duplicate CRFs, and long samples", () => {
    const decodePosition = Schema.decodeUnknownSync(ComparisonPositionSchema);
    const decodeOptions = Schema.decodeUnknownSync(CompareQualityOptionsSchema, {
      onExcessProperty: "error",
    });

    expect(() => decodePosition({ kind: "timecode", timecode: "01:75:00" })).toThrow();
    expect(() => decodePosition({ kind: "frame", frame: 1.5 })).toThrow();
    expect(() => decodeOptions({ codec: "vp9", crfs: [30, 30] })).toThrow();
    expect(() => decodeOptions({ codec: "vp9", crfs: [30, 40], durationSeconds: 3.01 })).toThrow();
  });
});

describe("matrix comparison options", () => {
  it("accepts a unique two-to-eight candidate codec and CRF matrix", () => {
    const options = {
      variants: [
        { codec: "vp9", crf: 36 },
        { codec: "h265", crf: 32 },
        { codec: "av1", crf: 40 },
      ],
      samples: { mode: "auto", count: 3 },
      objectiveMetrics: ["ssim", "psnr"],
      durationSeconds: 2,
    };

    expect(
      Schema.decodeUnknownSync(CompareQualityOptionsSchema, { onExcessProperty: "error" })(options),
    ).toEqual(options);
  });

  it("rejects duplicate, excessive, codec-invalid, and mixed matrix candidates", () => {
    const decode = Schema.decodeUnknownSync(CompareQualityOptionsSchema, {
      onExcessProperty: "error",
    });
    const duplicate = [
      { codec: "vp9", crf: 36 },
      { codec: "vp9", crf: 36 },
    ];
    const excessive = Array.from({ length: 9 }, (_, crf) => ({ codec: "vp9", crf: crf + 20 }));

    expect(() => decode({ variants: duplicate, objectiveMetrics: ["ssim"] })).toThrow();
    expect(() => decode({ variants: excessive, objectiveMetrics: ["ssim"] })).toThrow();
    expect(() =>
      decode({
        variants: [
          { codec: "vp9", crf: 36 },
          { codec: "h265", crf: 52 },
        ],
        objectiveMetrics: ["ssim"],
      }),
    ).toThrow();
    expect(() =>
      decode({
        codec: "vp9",
        crfs: [30, 40],
        variants: [
          { codec: "vp9", crf: 30 },
          { codec: "vp9", crf: 40 },
        ],
        objectiveMetrics: ["ssim"],
      }),
    ).toThrow();
  });
});

describe("comparison sample and metric selection", () => {
  it("accepts one-to-five unique explicit samples and rejects invalid sample selections", () => {
    const decode = Schema.decodeUnknownSync(CompareQualityOptionsSchema, {
      onExcessProperty: "error",
    });
    const variants = [
      { codec: "vp9", crf: 30 },
      { codec: "h265", crf: 30 },
    ];
    const positions = [
      { kind: "seconds", seconds: 10 },
      { kind: "timecode", timecode: "00:42.500" },
      { kind: "frame", frame: 1_200 },
    ];
    const options = {
      variants,
      samples: { mode: "positions", positions },
      objectiveMetrics: ["ssim"],
    };

    expect(decode(options)).toEqual(options);
    expect(() =>
      decode({
        ...options,
        samples: { mode: "positions", positions: [] },
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...options,
        samples: { mode: "positions", positions: [positions[0], positions[0]] },
      }),
    ).toThrow();
    expect(() => decode({ ...options, samples: { mode: "auto", count: 6 } })).toThrow();
  });

  it("requires SSIM and permits PSNR only as an optional metric", () => {
    const decode = Schema.decodeUnknownSync(CompareQualityOptionsSchema, {
      onExcessProperty: "error",
    });
    const variants = [
      { codec: "vp9", crf: 30 },
      { codec: "vp9", crf: 40 },
    ];

    expect(decode({ variants, objectiveMetrics: ["ssim"] })).toMatchObject({ variants });
    expect(decode({ variants, objectiveMetrics: ["psnr", "ssim"] })).toMatchObject({ variants });
    expect(() => decode({ variants, objectiveMetrics: ["psnr"] })).toThrow();
    expect(() => decode({ variants, objectiveMetrics: ["ssim", "ssim"] })).toThrow();
  });
});

const comparisonResult = {
  kind: "compare-quality",
  samples: [{ sampleId: "sample-1", normalizedStartSeconds: 9, actualSampleDurationSeconds: 2 }],
  variants: [
    {
      variantId: "vp9-36",
      codec: "vp9",
      crf: 36,
      previewArtifactId: "a1",
      stillArtifactId: "a2",
      sampleBytes: 12_345,
      estimatedFullVideoBytes: 617_250,
      estimateBasis: "video-only-sample-bitrate-extrapolation",
      metrics: { ssim: 0.982, psnr: 41.7 },
      paretoOptimal: false,
    },
    {
      variantId: "h265-32",
      codec: "h265",
      crf: 32,
      previewArtifactId: "a3",
      stillArtifactId: "a4",
      sampleBytes: 11_000,
      estimatedFullVideoBytes: 550_000,
      estimateBasis: "video-only-sample-bitrate-extrapolation",
      metrics: { ssim: 1, psnr: "infinite" },
      paretoOptimal: true,
    },
  ],
  decision: {
    basis: "balanced-ssim-size",
    recommendedVariantId: "h265-32",
    paretoVariantIds: ["h265-32"],
    confidence: "low",
    confidenceBasis: {
      sampleCount: 1,
      independentSampleCount: 1,
      temporalSpanRatio: 0,
      sampledDurationRatio: 0.02,
    },
  },
};

describe("canonical comparison results", () => {
  const decode = Schema.decodeUnknownSync(CompareQualityResultSchema, {
    onExcessProperty: "error",
  });
  it("returns sample facts, stable output IDs, objective metrics, and honest coverage", () => {
    expect(decode(comparisonResult)).toEqual(comparisonResult);
  });
  it.each(["codec", "normalizedStartSeconds", "actualSampleDurationSeconds", "commands"])(
    "rejects retired summary field %s",
    (key) => {
      expect(() => decode({ ...comparisonResult, [key]: "retired" })).toThrow();
    },
  );
  it("rejects invalid metrics and mismatched candidate or coverage evidence", () => {
    for (const metrics of [{ ssim: 1.01 }, { ssim: 0.9, psnr: -1 }, { psnr: 30 }]) {
      expect(() =>
        decode({
          ...comparisonResult,
          variants: comparisonResult.variants.map((variant) => ({ ...variant, metrics })),
        }),
      ).toThrow();
    }
    expect(() =>
      decode({ ...comparisonResult, variants: comparisonResult.variants.slice(0, 1) }),
    ).toThrow();
    expect(() =>
      decode({
        ...comparisonResult,
        decision: { ...comparisonResult.decision, recommendedVariantId: "missing" },
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...comparisonResult,
        decision: {
          ...comparisonResult.decision,
          confidenceBasis: {
            ...comparisonResult.decision.confidenceBasis,
            independentSampleCount: 2,
          },
        },
      }),
    ).toThrow();
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
