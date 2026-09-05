import { describe, expect, it } from "vitest";

import {
  buildQualityComparisonVariantPlans,
  buildQualityMetricPlan,
  buildQualityReferencePlan,
  estimateFullVideoBytes,
  normalizeQualityComparisonOptions,
  resolveQualityComparisonSamples,
} from "../src/media/quality-comparison-plan.ts";
import { expectCommandSequence } from "./expect-command.ts";

describe("full-video size estimates", () => {
  it("linearly extrapolates the encoded sample and rounds up", () => {
    expect(
      estimateFullVideoBytes({
        sampleBytes: 1_000_001,
        sampleDurationSeconds: 3,
        sourceDurationSeconds: 10,
      }),
    ).toBe(3_333_337);
  });

  it("rejects invalid estimate measurements", () => {
    expect(() =>
      estimateFullVideoBytes({
        sampleBytes: -1,
        sampleDurationSeconds: 1,
        sourceDurationSeconds: 10,
      }),
    ).toThrow(/sample bytes/i);
  });
});

describe("quality comparison request normalization", () => {
  it("defaults a matrix to three auto samples without reordering candidates or metrics", () => {
    expect(
      normalizeQualityComparisonOptions({
        variants: [
          { codec: "h265", crf: 32 },
          { codec: "vp9", crf: 36 },
        ],
        objectiveMetrics: ["psnr", "ssim"],
      }),
    ).toMatchObject({
      durationSeconds: 1,
      objectiveMetrics: ["psnr", "ssim"],
      sampleSelection: { mode: "auto", count: 3 },
      variants: [
        { codec: "h265", crf: 32, variantId: "variant-h265-crf-32" },
        { codec: "vp9", crf: 36, variantId: "variant-vp9-crf-36" },
      ],
    });
  });
});

describe("quality comparison samples", () => {
  it("places automatic samples at deterministic temporal centers", () => {
    expect(
      resolveQualityComparisonSamples({
        durationSeconds: 2,
        sampleSelection: { mode: "auto", count: 3 },
        sourceDurationSeconds: 100,
      }),
    ).toEqual([
      { sampleId: "sample-1", normalizedStartSeconds: 24, actualSampleDurationSeconds: 2 },
      { sampleId: "sample-2", normalizedStartSeconds: 49, actualSampleDurationSeconds: 2 },
      { sampleId: "sample-3", normalizedStartSeconds: 74, actualSampleDurationSeconds: 2 },
    ]);
  });

  it("uses the whole source for overlapping samples when media is shorter than a sample", () => {
    expect(
      resolveQualityComparisonSamples({
        durationSeconds: 3,
        sampleSelection: { mode: "auto", count: 2 },
        sourceDurationSeconds: 1,
      }),
    ).toEqual([
      { sampleId: "sample-1", normalizedStartSeconds: 0, actualSampleDurationSeconds: 1 },
      { sampleId: "sample-2", normalizedStartSeconds: 0, actualSampleDurationSeconds: 1 },
    ]);
  });

  it("preserves a short near-EOF sample and resolves frame positions", () => {
    expect(
      resolveQualityComparisonSamples({
        durationSeconds: 1,
        resolvedFrameTimestamps: [null, 4.25],
        sampleSelection: {
          mode: "positions",
          positions: [
            { kind: "seconds", seconds: 9.75 },
            { kind: "frame", frame: 102 },
          ],
        },
        sourceDurationSeconds: 10,
      }),
    ).toEqual([
      { sampleId: "sample-1", normalizedStartSeconds: 9.75, actualSampleDurationSeconds: 0.25 },
      { sampleId: "sample-2", normalizedStartSeconds: 4.25, actualSampleDurationSeconds: 1 },
    ]);
  });
});

describe("quality comparison reference and variant plans", () => {
  const samples = [
    { sampleId: "sample-1", normalizedStartSeconds: 24, actualSampleDurationSeconds: 2 },
    { sampleId: "sample-2", normalizedStartSeconds: 74, actualSampleDurationSeconds: 2 },
  ];

  it("builds one transformed FFV1 Matroska reference reel", () => {
    const plan = buildQualityReferencePlan({
      executable: "ffmpeg",
      inputPath: "/tmp/input.mp4",
      outputPath: "/tmp/reference.mkv",
      samples,
      source: { height: 1080, width: 1920 },
      transform: { scale: { width: 1280 } },
    });

    expectCommandSequence(plan.argv, "-filter_complex");
    expect(plan.argv[plan.argv.indexOf("-filter_complex") + 1]).toBe(
      "[0:v:0]split=2[input0][input1];" +
        "[input0]trim=start=24:duration=2,setpts=PTS-STARTPTS,scale=1280:-2[sample0];" +
        "[input1]trim=start=74:duration=2,setpts=PTS-STARTPTS,scale=1280:-2[sample1];" +
        "[sample0][sample1]concat=n=2:v=1:a=0[reference]",
    );
    expectCommandSequence(plan.argv, "-map", "[reference]", "-an", "-c:v", "ffv1");
    expect(plan.argv.at(-1)).toBe("/tmp/reference.mkv");
  });

  it("splits multi-sample input and fixes the lossless reference pixel format", () => {
    const plan = buildQualityReferencePlan({
      inputPath: "/tmp/input.mp4",
      outputPath: "/tmp/reference.mkv",
      samples,
      source: { height: 1080, width: 1920 },
    });
    const filter = plan.argv[plan.argv.indexOf("-filter_complex") + 1];

    expect(filter).toContain("[0:v:0]split=2[input0][input1]");
    expect(filter).toContain("[input0]trim=start=24:duration=2");
    expect(filter).toContain("[input1]trim=start=74:duration=2");
    expectCommandSequence(plan.argv, "-c:v", "ffv1", "-pix_fmt", "yuv420p");
  });

  it("builds mixed-codec pipelines in request order against the same reference", () => {
    const plans = buildQualityComparisonVariantPlans({
      executable: "ffmpeg",
      objectiveMetrics: ["ssim", "psnr"],
      outputPaths: [
        {
          preview: "/tmp/h265.mp4",
          psnrStats: "/tmp/h265-psnr.log",
          ssimStats: "/tmp/h265-ssim.log",
          still: "/tmp/h265.jpg",
        },
        {
          preview: "/tmp/vp9.webm",
          psnrStats: "/tmp/vp9-psnr.log",
          ssimStats: "/tmp/vp9-ssim.log",
          still: "/tmp/vp9.jpg",
        },
      ],
      referencePath: "/tmp/reference.mkv",
      sampleDurationSeconds: 4,
      source: { height: 720, width: 1280 },
      variants: [
        { codec: "h265", crf: 32, variantId: "variant-h265-crf-32" },
        { codec: "vp9", crf: 36, variantId: "variant-vp9-crf-36" },
      ],
    });

    expect(plans.map(({ codec, crf }) => ({ codec, crf }))).toEqual([
      { codec: "h265", crf: 32 },
      { codec: "vp9", crf: 36 },
    ]);
    expectCommandSequence(plans[0]?.preview.argv, "-i", "/tmp/reference.mkv");
    expectCommandSequence(plans[0]?.preview.argv, "-c:v", "libx265");
    expectCommandSequence(plans[1]?.preview.argv, "-i", "/tmp/reference.mkv");
    expectCommandSequence(plans[1]?.preview.argv, "-c:v", "libvpx-vp9");
    expect(plans[0]?.metrics.map(({ kind }) => kind)).toEqual(["ssim", "psnr"]);
    expectCommandSequence(plans[0]?.representativeFrame.argv, "-ss", "2", "-frames:v", "1");
  });

  it("builds metric commands with staging stats and a null output", () => {
    const plan = buildQualityMetricPlan({
      executable: "ffmpeg",
      kind: "ssim",
      previewPath: "/tmp/preview.webm",
      referencePath: "/tmp/reference.mkv",
      statsPath: "/tmp/ssim.log",
    });

    expectCommandSequence(plan.argv, "-i", "/tmp/preview.webm", "-i", "/tmp/reference.mkv");
    expectCommandSequence(plan.argv, "-lavfi", "ssim=stats_file=/tmp/ssim.log", "-f", "null");
    expect(plan.argv.at(-1)).toBe("-");
  });
});
