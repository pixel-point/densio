import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, readFile, readdir } from "node:fs/promises";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  MediaWorkflowArchiveError,
  MediaWorkflowProcessError,
  runImageExtractionWorkflow,
} from "../src/media/workflows/image-extraction-workflow.ts";
import {
  cleanupWorkflowTestRoots,
  makeWorkflowTestContext,
  provideWorkflowRunner,
} from "./media-workflow-test-support.ts";

const execFilePromise = promisify(execFile);

afterEach(cleanupWorkflowTestRoots);

describe("image extraction workflow", () => {
  it("streams interval images and a timestamp manifest into a real ZIP", async () => {
    const { executable, paths } = await makeWorkflowTestContext("success");

    const result = await Effect.runPromise(
      provideWorkflowRunner(
        runImageExtractionWorkflow({
          executable,
          format: "jpeg",
          intervalSeconds: 0.5,
          paths,
          source: { height: 720, width: 1280 },
          sourceDurationSeconds: 1.2,
        }),
      ),
    );

    expect(result).toMatchObject({
      archive: {
        artifactFilename: "images.zip",
        durationSeconds: 1.2,
        height: 720,
        kind: "image-archive",
        mediaType: "application/zip",
        stagedFilename: "extracted-images.zip",
        width: 1_280,
      },
      imageCount: 3,
      intervalSeconds: 0.5,
      manifest: {
        format: "jpeg",
        frames: [
          { filename: "frame-000001.jpg", timestampSeconds: 0 },
          { filename: "frame-000002.jpg", timestampSeconds: 0.5 },
          { filename: "frame-000003.jpg", timestampSeconds: 1 },
        ],
        intervalSeconds: 0.5,
        kind: "extract-images",
        schemaVersion: 1,
        source: { durationSeconds: 1.2, height: 720, width: 1280 },
      },
    });
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]?.arguments).toEqual(expect.arrayContaining(["-progress", "pipe:1"]));
    expect(await readdir(paths.stagingDirectory)).toEqual(["extracted-images.zip"]);
    const archivePath = `${paths.stagingDirectory}/extracted-images.zip`;
    expect((await readFile(archivePath)).subarray(0, 2).toString("ascii")).toBe("PK");
    const listing = await execFilePromise("/usr/bin/unzip", ["-Z1", archivePath]);
    expect(listing.stdout.trim().split("\n").toSorted()).toEqual([
      "frame-000001.jpg",
      "frame-000002.jpg",
      "frame-000003.jpg",
      "manifest.json",
    ]);
    const archivedManifest = await execFilePromise("/usr/bin/unzip", [
      "-p",
      archivePath,
      "manifest.json",
    ]);
    expect(JSON.parse(archivedManifest.stdout)).toEqual(result.manifest);
    await expect(access(paths.artifactDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("carries transformed output dimensions on the staged archive", async () => {
    const { executable, paths } = await makeWorkflowTestContext("success");

    const result = await Effect.runPromise(
      provideWorkflowRunner(
        runImageExtractionWorkflow({
          executable,
          paths,
          source: { height: 1_080, width: 1_920 },
          sourceDurationSeconds: 2,
          transform: { scale: { width: 640 } },
        }),
      ),
    );

    expect(result.archive).toMatchObject({ width: 640, height: 360 });
  });
});

describe("image extraction workflow failures", () => {
  it("removes partial frames after the extraction command fails", async () => {
    const { executable, paths } = await makeWorkflowTestContext("fail-extraction");

    const error = await Effect.runPromise(
      Effect.flip(
        provideWorkflowRunner(
          runImageExtractionWorkflow({
            executable,
            paths,
            source: { height: 720, width: 1280 },
            sourceDurationSeconds: 3,
          }),
        ),
      ),
    );

    expect(error).toBeInstanceOf(MediaWorkflowProcessError);
    if (!(error instanceof MediaWorkflowProcessError)) throw error;
    expect(error.failedCommand.arguments.at(-1)).toContain("frame-%06d.jpg");
    await expect(access(paths.stagingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes frames and a partial archive after ZIP creation fails", async () => {
    const { executable, paths } = await makeWorkflowTestContext("archive-fail");

    const error = await Effect.runPromise(
      Effect.flip(
        provideWorkflowRunner(
          runImageExtractionWorkflow({
            executable,
            paths,
            source: { height: 720, width: 1280 },
            sourceDurationSeconds: 3,
          }),
        ),
      ),
    );

    expect(error).toBeInstanceOf(MediaWorkflowArchiveError);
    if (!(error instanceof MediaWorkflowArchiveError)) throw error;
    expect(error.commands).toHaveLength(1);
    expect(error.commands[0]?.arguments.at(-1)).toContain("frame-%06d.jpg");
    await expect(access(paths.stagingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(paths.artifactDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
