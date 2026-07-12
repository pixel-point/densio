import { describe, expect, it } from "vitest";

import {
  buildQualityComparisonPlans,
  estimateFullVideoBytes,
} from "../src/media/quality-comparison-plan.ts";
import { expectCommandSequence } from "./expect-command.ts";

const baseOptions = {
  codec: "vp9",
  crfs: [30, 40],
  inputPath: "/tmp/input.mp4",
  outputPaths: [
    { preview: "/tmp/30.webm", still: "/tmp/30.jpg" },
    { preview: "/tmp/40.webm", still: "/tmp/40.jpg" },
  ],
  source: { width: 1920, height: 1080 },
  audio: "remove",
} as const;

describe("quality comparison plans", () => {
  it("builds one-second preview and representative-frame plans from zero", () => {
    const variants = buildQualityComparisonPlans(baseOptions);

    expect(variants.map(({ crf }) => crf)).toEqual([30, 40]);
    expectCommandSequence(variants[0]?.preview.argv, "-ss", "0", "-t", "1");
    expect(variants[0]?.preview.argv.at(-1)).toBe("/tmp/30.webm");
    expectCommandSequence(
      variants[0]?.representativeFrame.argv,
      "-i",
      "/tmp/30.webm",
      "-ss",
      "0.5",
      "-frames:v",
      "1",
    );
  });

  it("supports a three-second sample from an explicit timecode", () => {
    const variants = buildQualityComparisonPlans({
      ...baseOptions,
      durationSeconds: 3,
      position: { kind: "timecode", timecode: "01:02.500" },
    });

    expect(variants[0]?.startSeconds).toBe(62.5);
    expectCommandSequence(variants[0]?.preview.argv, "-ss", "62.5", "-t", "3");
  });

  it("uses a probe-resolved timestamp for an exact frame position", () => {
    const variants = buildQualityComparisonPlans({
      ...baseOptions,
      position: { kind: "frame", frame: 172 },
      resolvedFrameTimestampSeconds: 7.291,
    });

    expect(variants[0]?.startSeconds).toBe(7.291);
    expect(variants[0]?.sourceFrame).toBe(172);
  });

  it("uses the actual remaining sample duration for a representative frame near EOF", () => {
    const variants = buildQualityComparisonPlans({
      ...baseOptions,
      durationSeconds: 1,
      position: { kind: "seconds", seconds: 9.75 },
      sourceDurationSeconds: 10,
    });

    expect(variants[0]?.durationSeconds).toBe(0.25);
    expectCommandSequence(variants[0]?.preview.argv, "-ss", "9.75", "-t", "0.25");
    expectCommandSequence(variants[0]?.representativeFrame.argv, "-ss", "0.125");
  });

  it.each([0, 0.99, 3.01, Number.NaN])("rejects an invalid sample duration", (duration) => {
    expect(() =>
      buildQualityComparisonPlans({ ...baseOptions, durationSeconds: duration }),
    ).toThrow(/duration/i);
  });

  it("requires two to eight unique CRFs and a path pair for each", () => {
    expect(() =>
      buildQualityComparisonPlans({
        ...baseOptions,
        crfs: [30],
        outputPaths: [{ preview: "/tmp/30.webm", still: "/tmp/30.jpg" }],
      }),
    ).toThrow(/2.*8/);
    expect(() => buildQualityComparisonPlans({ ...baseOptions, crfs: [30, 30] })).toThrow(
      /unique/i,
    );
    expect(() =>
      buildQualityComparisonPlans({ ...baseOptions, outputPaths: [baseOptions.outputPaths[0]] }),
    ).toThrow(/output path/i);
  });

  it("rejects invalid positions that bypass transport validation", () => {
    expect(() =>
      buildQualityComparisonPlans({
        ...baseOptions,
        position: { kind: "timecode", timecode: "00:01;touch pwned" },
      }),
    ).toThrow(/timecode/i);
    expect(() =>
      buildQualityComparisonPlans({
        ...baseOptions,
        position: { kind: "timecode", timecode: "100:00:00" },
      }),
    ).toThrow(/timecode/i);
    expect(() =>
      buildQualityComparisonPlans({
        ...baseOptions,
        position: { kind: "frame", frame: 1 },
      }),
    ).toThrow(/resolved frame/i);
  });
});

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
