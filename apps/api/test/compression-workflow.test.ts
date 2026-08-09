import { access, readFile } from "node:fs/promises";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  MediaWorkflowProcessError,
  runCompressionWorkflow,
} from "../src/media/workflows/compression-workflow.ts";
import {
  cleanupWorkflowTestRoots,
  makeWorkflowTestContext,
  provideWorkflowRunner,
} from "./media-workflow-test-support.ts";

afterEach(cleanupWorkflowTestRoots);

describe("compression workflow", () => {
  it("executes every selected codec into staging and returns publishable descriptors", async () => {
    const { executable, paths } = await makeWorkflowTestContext("require-concurrent-codecs");

    const result = await Effect.runPromise(
      provideWorkflowRunner(
        runCompressionWorkflow({
          audio: "remove",
          codecs: ["vp9", "h265", "av1"],
          executable,
          paths,
          source: { height: 1080, width: 1920 },
        }),
      ),
    );

    expect(result.outputs).toEqual([
      {
        artifactFilename: "video-vp9.webm",
        codec: "vp9",
        kind: "video",
        mediaType: "video/webm",
        stagedFilename: "compressed-vp9.webm",
      },
      {
        artifactFilename: "video-h265.mp4",
        codec: "h265",
        kind: "video",
        mediaType: "video/mp4",
        stagedFilename: "compressed-h265.mp4",
      },
      {
        artifactFilename: "video-av1.webm",
        codec: "av1",
        kind: "video",
        mediaType: "video/webm",
        stagedFilename: "compressed-av1.webm",
      },
    ]);
    expect(result.commands).toHaveLength(3);
    expect(result.commands[0]).toMatchObject({
      arguments: expect.arrayContaining(["libvpx-vp9"]),
      executable,
      exitCode: 0,
    });
    expect(result.commands[0]?.displayCommand).toContain(executable);
    await expect(readFile(`${paths.stagingDirectory}/compressed-vp9.webm`)).resolves.toHaveLength(
      420,
    );
    await expect(access(paths.artifactDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes all staged outputs after a command fails and preserves its argv diagnostic", async () => {
    const { executable, paths } = await makeWorkflowTestContext("fail-h265");

    const error = await Effect.runPromise(
      Effect.flip(
        provideWorkflowRunner(
          runCompressionWorkflow({
            audio: "remove",
            codecs: ["vp9", "h265"],
            executable,
            paths,
            source: { height: 1080, width: 1920 },
          }),
        ),
      ),
    );

    expect(error).toBeInstanceOf(MediaWorkflowProcessError);
    if (!(error instanceof MediaWorkflowProcessError)) throw error;
    expect(error).toMatchObject({ exitCode: 9, stderrTail: "deterministic workflow failure" });
    expect(error.completedCommands).toHaveLength(1);
    expect(error.completedCommands[0]?.arguments.at(-1)).toContain("compressed-vp9.webm");
    expect(error.failedCommand.arguments.at(-1)).toContain("compressed-h265.mp4");
    await expect(access(paths.stagingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(paths.inputFile, "utf8")).resolves.toBe("source-video");
    await expect(access(paths.artifactDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
