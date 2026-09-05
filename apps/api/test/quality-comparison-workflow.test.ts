import { access, readdir } from "node:fs/promises";

import { resolveQualityComparisonSamples } from "../src/media/quality-comparison-plan.ts";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  MediaWorkflowInputError,
  MediaWorkflowProcessError,
  runQualityComparisonWorkflow,
} from "../src/media/workflows/quality-comparison-workflow.ts";
import type { MediaProcessCommand } from "../src/media/process/media-process-runner.ts";
import {
  cleanupWorkflowTestRoots,
  makeWorkflowTestContext,
  provideWorkflowRunner,
} from "./media-workflow-test-support.ts";

afterEach(cleanupWorkflowTestRoots);

describe("quality comparison workflow", () => {
  it("runs ordered variant pipelines concurrently and returns measured size estimates", async () => {
    const { executable, paths } = await makeWorkflowTestContext("require-concurrent-previews");

    const result = await Effect.runPromise(
      provideWorkflowRunner(
        runQualityComparisonWorkflow({
          resolvedOptions: {
            variants: [
              { codec: "vp9", crf: 30 },
              { codec: "vp9", crf: 40 },
            ],
            objectiveMetrics: ["ssim"],
            samples: [
              { sampleId: "sample-1", normalizedStartSeconds: 1, actualSampleDurationSeconds: 2 },
            ],
          },
          executable,
          paths,
          source: { height: 1080, width: 1920 },
          sourceDurationSeconds: 10,
        }),
      ),
    );

    expect(result).toMatchObject({
      samples: [
        { sampleId: "sample-1", actualSampleDurationSeconds: 2, normalizedStartSeconds: 1 },
      ],
      variants: [
        {
          crf: 30,
          estimatedFullVideoBytes: 1_500,
          sampleBytes: 300,
        },
        {
          crf: 40,
          estimatedFullVideoBytes: 2_000,
          sampleBytes: 400,
        },
      ],
    });
    expect(result.variants[0]?.preview).toMatchObject({
      artifactFilename: "comparison-vp9-crf-30.webm",
      codec: "vp9",
      kind: "preview-video",
      mediaType: "video/webm",
      stagedFilename: "preview-vp9-crf-30.webm",
    });
    expect(result.variants[0]?.still).toMatchObject({
      artifactFilename: "comparison-vp9-crf-30.jpg",
      kind: "preview-image",
      mediaType: "image/jpeg",
      stagedFilename: "still-vp9-crf-30.jpg",
    });
    expect(result.commands.map((command) => command.arguments.at(-1))).toEqual([
      `${paths.stagingDirectory}/quality-reference.mkv`,
      `${paths.stagingDirectory}/preview-vp9-crf-30.webm`,
      `${paths.stagingDirectory}/still-vp9-crf-30.jpg`,
      "-",
      `${paths.stagingDirectory}/preview-vp9-crf-40.webm`,
      `${paths.stagingDirectory}/still-vp9-crf-40.jpg`,
      "-",
    ]);
    expect(result.commands[0]?.arguments).toEqual(expect.arrayContaining(["-progress", "pipe:1"]));
    expect(result.commands[1]?.arguments).toEqual(expect.arrayContaining(["-progress", "pipe:1"]));
    expect(result.commands[3]?.arguments).toEqual(expect.arrayContaining(["-progress", "pipe:1"]));
    expect(result.commands[4]?.arguments).toEqual(expect.arrayContaining(["-progress", "pipe:1"]));
    expect(result.commands[6]?.arguments).toEqual(expect.arrayContaining(["-progress", "pipe:1"]));
    await expect(access(paths.artifactDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("comparison command failure cleanup", () => {
  it("removes every preview and still after a preview command fails", async () => {
    const { executable, paths } = await makeWorkflowTestContext("fail-preview");

    const error = await Effect.runPromise(
      Effect.flip(
        provideWorkflowRunner(
          runQualityComparisonWorkflow({
            resolvedOptions: {
              variants: [
                { codec: "vp9", crf: 30 },
                { codec: "vp9", crf: 40 },
              ],
              objectiveMetrics: ["ssim"],
              samples: [
                { sampleId: "sample-1", normalizedStartSeconds: 0, actualSampleDurationSeconds: 1 },
              ],
            },
            executable,
            paths,
            source: { height: 1080, width: 1920 },
            sourceDurationSeconds: 10,
          }),
        ),
      ),
    );

    expect(error).toBeInstanceOf(MediaWorkflowProcessError);
    if (!(error instanceof MediaWorkflowProcessError)) throw error;
    expect(
      error.completedCommands.some((command) =>
        command.arguments.at(-1)?.includes("preview-vp9-crf-30.webm"),
      ),
    ).toBe(true);
    expect(error.failedCommand.arguments.at(-1)).toContain("preview-vp9-crf-40.webm");
    await expect(access(paths.stagingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(paths.artifactDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("matrix quality comparison workflow", () => {
  it("uses persisted exact plan samples without recomputing their starts or durations", async () => {
    const { executable, paths } = await makeWorkflowTestContext("require-concurrent-previews");

    const result = await Effect.runPromise(
      provideWorkflowRunner(
        runQualityComparisonWorkflow({
          resolvedOptions: {
            variants: [
              { codec: "vp9", crf: 30 },
              { codec: "h265", crf: 32 },
            ],
            objectiveMetrics: ["ssim"],
            samples: [
              {
                sampleId: "opening",
                normalizedStartSeconds: 8.75,
                actualSampleDurationSeconds: 0.25,
              },
              {
                sampleId: "ending",
                normalizedStartSeconds: 9.5,
                actualSampleDurationSeconds: 0.5,
              },
            ],
          },
          executable,
          paths,
          source: { height: 1_080, width: 1_920 },
          sourceDurationSeconds: 10,
        }),
      ),
    );

    expect(result.samples).toEqual([
      {
        sampleId: "opening",
        normalizedStartSeconds: 8.75,
        actualSampleDurationSeconds: 0.25,
      },
      {
        sampleId: "ending",
        normalizedStartSeconds: 9.5,
        actualSampleDurationSeconds: 0.5,
      },
    ]);
    expect(result.commands[0]?.arguments.join(" ")).toContain("trim=start=8.75:duration=0.25");
    expect(result.commands[0]?.arguments.join(" ")).toContain("trim=start=9.5:duration=0.5");
  });
});

describe("quality comparison progress", () => {
  it("finishes every preview before measuring with unique aggregate metric indexes", async () => {
    const { executable, paths } = await makeWorkflowTestContext("require-preview-barrier");
    const progressContexts: Array<NonNullable<MediaProcessCommand["progressContext"]>> = [];

    await Effect.runPromise(
      provideWorkflowRunner(
        runQualityComparisonWorkflow({
          resolvedOptions: {
            variants: [
              { codec: "vp9", crf: 30 },
              { codec: "h265", crf: 32 },
            ],
            objectiveMetrics: ["ssim", "psnr"],
            samples: [
              { sampleId: "sample-1", normalizedStartSeconds: 0, actualSampleDurationSeconds: 1 },
            ],
          },
          executable,
          paths,
          source: { height: 1_080, width: 1_920 },
          sourceDurationSeconds: 10,
        }),
        ({ progressContext }) => {
          if (progressContext !== undefined) progressContexts.push(progressContext);
        },
      ),
    );

    const firstMeasuring = progressContexts.findIndex(({ phase }) => phase === "measuring");
    const lastEncoding = progressContexts.findLastIndex(({ phase }) => phase === "encoding");
    expect(firstMeasuring).toBeGreaterThan(lastEncoding);
    expect(
      progressContexts
        .filter(({ phase }) => phase === "measuring")
        .toSorted(({ index: left }, { index: right }) => left - right)
        .map(({ filename, index, total }) => ({ filename, index, total })),
    ).toEqual([
      { filename: "ssim-variant-vp9-crf-30.log", index: 1, total: 4 },
      { filename: "psnr-variant-vp9-crf-30.log", index: 2, total: 4 },
      { filename: "ssim-variant-h265-crf-32.log", index: 3, total: 4 },
      { filename: "psnr-variant-h265-crf-32.log", index: 4, total: 4 },
    ]);
  });
});

describe("matrix quality comparison execution", () => {
  it("builds one reference and measures mixed-codec variants concurrently in request order", async () => {
    const { executable, paths } = await makeWorkflowTestContext("require-concurrent-previews");

    const result = await Effect.runPromise(
      provideWorkflowRunner(
        runQualityComparisonWorkflow({
          resolvedOptions: {
            variants: [
              { codec: "vp9", crf: 30 },
              { codec: "h265", crf: 32 },
            ],
            objectiveMetrics: ["ssim", "psnr"],
            samples: resolveQualityComparisonSamples({
              sampleSelection: { mode: "auto", count: 2 },
              durationSeconds: 2,
              sourceDurationSeconds: 10,
            }),
          },
          executable,
          paths,
          source: { height: 1080, width: 1920 },
          sourceDurationSeconds: 10,
        }),
      ),
    );

    expect(result.samples).toEqual([
      {
        sampleId: "sample-1",
        normalizedStartSeconds: 2.3333333333333335,
        actualSampleDurationSeconds: 2,
      },
      {
        sampleId: "sample-2",
        normalizedStartSeconds: 5.666666666666667,
        actualSampleDurationSeconds: 2,
      },
    ]);
    expect(result.variants).toMatchObject([
      {
        codec: "vp9",
        crf: 30,
        variantId: "variant-vp9-crf-30",
        sampleBytes: 300,
        estimatedFullVideoBytes: 750,
        metrics: { ssim: 0.97, psnr: 35 },
      },
      {
        codec: "h265",
        crf: 32,
        variantId: "variant-h265-crf-32",
        sampleBytes: 320,
        estimatedFullVideoBytes: 800,
        metrics: { ssim: 0.968, psnr: 34 },
      },
    ]);
    expect(result.decision).toMatchObject({
      basis: "balanced-ssim-size",
      recommendedVariantId: "variant-vp9-crf-30",
      paretoVariantIds: ["variant-vp9-crf-30"],
      confidence: "medium",
      confidenceBasis: { sampleCount: 2 },
    });
    expect(result.commands).toHaveLength(9);
    expect(result.commands[0]?.arguments.at(-1)).toBe(
      `${paths.stagingDirectory}/quality-reference.mkv`,
    );
    expect(await readdir(paths.stagingDirectory)).toEqual(
      expect.arrayContaining([
        "quality-reference.mkv",
        "ssim-vp9-crf-30.log",
        "psnr-vp9-crf-30.log",
      ]),
    );
    await expect(access(paths.artifactDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("comparison measurement failure cleanup", () => {
  it("cleans all staging files when FFmpeg returns malformed metrics", async () => {
    const { executable, paths } = await makeWorkflowTestContext("malformed-metrics");

    const error = await Effect.runPromise(
      Effect.flip(
        provideWorkflowRunner(
          runQualityComparisonWorkflow({
            resolvedOptions: {
              variants: [
                { codec: "vp9", crf: 30 },
                { codec: "h265", crf: 32 },
              ],
              objectiveMetrics: ["ssim"],
              samples: [
                { sampleId: "sample-1", normalizedStartSeconds: 0, actualSampleDurationSeconds: 1 },
              ],
            },
            executable,
            paths,
            source: { height: 1080, width: 1920 },
            sourceDurationSeconds: 10,
          }),
        ),
      ),
    );

    expect(error).toBeInstanceOf(MediaWorkflowInputError);
    await expect(access(paths.stagingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
