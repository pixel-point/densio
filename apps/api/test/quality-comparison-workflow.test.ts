import { access } from "node:fs/promises";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  MediaWorkflowProcessError,
  runQualityComparisonWorkflow,
} from "../src/media/workflows/quality-comparison-workflow.ts";
import {
  cleanupWorkflowTestRoots,
  makeWorkflowTestContext,
  provideWorkflowRunner,
} from "./media-workflow-test-support.ts";

afterEach(cleanupWorkflowTestRoots);

describe("quality comparison workflow", () => {
  it("encodes all previews before stills and returns measured size estimates", async () => {
    const { executable, paths } = await makeWorkflowTestContext("require-two-previews");

    const result = await Effect.runPromise(
      provideWorkflowRunner(
        runQualityComparisonWorkflow({
          codec: "vp9",
          crfs: [30, 40],
          durationSeconds: 2,
          executable,
          paths,
          position: { kind: "seconds", seconds: 1 },
          source: { height: 1080, width: 1920 },
          sourceDurationSeconds: 10,
        }),
      ),
    );

    expect(result).toMatchObject({
      actualSampleDurationSeconds: 2,
      codec: "vp9",
      normalizedStartSeconds: 1,
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
      `${paths.stagingDirectory}/preview-vp9-crf-30.webm`,
      `${paths.stagingDirectory}/preview-vp9-crf-40.webm`,
      `${paths.stagingDirectory}/still-vp9-crf-30.jpg`,
      `${paths.stagingDirectory}/still-vp9-crf-40.jpg`,
    ]);
    await expect(access(paths.artifactDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes every preview and still after a preview command fails", async () => {
    const { executable, paths } = await makeWorkflowTestContext("fail-preview");

    const error = await Effect.runPromise(
      Effect.flip(
        provideWorkflowRunner(
          runQualityComparisonWorkflow({
            codec: "vp9",
            crfs: [30, 40],
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
    expect(error.completedCommands).toHaveLength(1);
    expect(error.completedCommands[0]?.arguments.at(-1)).toContain("preview-vp9-crf-30.webm");
    expect(error.failedCommand.arguments.at(-1)).toContain("preview-vp9-crf-40.webm");
    await expect(access(paths.stagingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(paths.artifactDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
