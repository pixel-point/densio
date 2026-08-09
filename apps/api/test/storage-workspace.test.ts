import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  InvalidStoragePath,
  type JobStoragePaths,
  cleanupJobWorkspace,
  makeJobStoragePaths,
  prepareJobWorkspace,
  resolveArtifactFile,
  resolveStagedFile,
} from "../src/storage/workspace.ts";

const temporaryRoots: Array<string> = [];

const makeTemporaryRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), "densio-storage-"));
  temporaryRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("job storage paths", () => {
  it("constructs private per-job paths underneath the media root", async () => {
    const mediaRoot = await makeTemporaryRoot();
    const paths = await Effect.runPromise(makeJobStoragePaths(mediaRoot, "job-123"));

    expect(paths).toEqual({
      artifactDirectory: resolve(mediaRoot, "artifacts", "job-123"),
      inputFile: resolve(mediaRoot, "work", "job-123", "input", "source-video"),
      mediaRoot: resolve(mediaRoot),
      stagingDirectory: resolve(mediaRoot, "work", "job-123", "staging"),
      workspaceDirectory: resolve(mediaRoot, "work", "job-123"),
    });
    expect(await Effect.runPromise(resolveStagedFile(paths, "compressed-video.webm"))).toBe(
      resolve(paths.stagingDirectory, "compressed-video.webm"),
    );
    expect(await Effect.runPromise(resolveArtifactFile(paths, "compressed-video.webm"))).toBe(
      resolve(paths.artifactDirectory, "compressed-video.webm"),
    );
  });

  it.each(["../escape", "nested/job", "/absolute", ".", "", "job name"])(
    "rejects unsafe job id %j",
    async (jobId) => {
      const error = await Effect.runPromise(
        Effect.flip(makeJobStoragePaths(await makeTemporaryRoot(), jobId)),
      );

      expect(error).toBeInstanceOf(InvalidStoragePath);
    },
  );

  it.each(["../escape.webm", "nested/output.webm", "/tmp/output.webm", ".", ".."])(
    "rejects artifact names that escape or nest outside the job directory: %j",
    async (filename) => {
      const paths = await Effect.runPromise(
        makeJobStoragePaths(await makeTemporaryRoot(), "job-safe"),
      );
      const error = await Effect.runPromise(Effect.flip(resolveArtifactFile(paths, filename)));

      expect(error).toBeInstanceOf(InvalidStoragePath);
    },
  );
});

describe("job workspace lifecycle", () => {
  it("prepares required directories and can be repeated", async () => {
    const paths = await Effect.runPromise(
      makeJobStoragePaths(await makeTemporaryRoot(), "job-prepare"),
    );

    await Effect.runPromise(prepareJobWorkspace(paths));
    await Effect.runPromise(prepareJobWorkspace(paths));

    await expect(access(join(paths.workspaceDirectory, "input"))).resolves.toBeUndefined();
    await expect(access(paths.stagingDirectory)).resolves.toBeUndefined();
  });

  it("cleans only the private workspace and cleanup is idempotent", async () => {
    const paths = await Effect.runPromise(
      makeJobStoragePaths(await makeTemporaryRoot(), "job-cleanup"),
    );
    await Effect.runPromise(prepareJobWorkspace(paths));
    await writeFile(paths.inputFile, "input");
    await Effect.runPromise(prepareJobWorkspace(paths, { includeArtifactDirectory: true }));
    await writeFile(join(paths.artifactDirectory, "result.webm"), "published");

    await Effect.runPromise(cleanupJobWorkspace(paths));
    await Effect.runPromise(cleanupJobWorkspace(paths));

    await expect(access(paths.workspaceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(paths.artifactDirectory, "result.webm"), "utf8")).resolves.toBe(
      "published",
    );
  });

  it("rejects a forged workspace object instead of deleting its target", async () => {
    const mediaRoot = await makeTemporaryRoot();
    const paths = await Effect.runPromise(makeJobStoragePaths(mediaRoot, "job-safe-cleanup"));
    const unrelatedDirectory = join(mediaRoot, "must-survive");
    await Effect.runPromise(prepareJobWorkspace(paths));
    await writeFile(join(paths.workspaceDirectory, "input", "marker"), "workspace");
    await mkdir(unrelatedDirectory);
    await writeFile(join(unrelatedDirectory, "marker"), "unrelated");
    const forged = { ...paths, workspaceDirectory: unrelatedDirectory } as JobStoragePaths;

    const error = await Effect.runPromise(Effect.flip(cleanupJobWorkspace(forged)));

    expect(error).toBeInstanceOf(InvalidStoragePath);
    await expect(readFile(join(unrelatedDirectory, "marker"), "utf8")).resolves.toBe("unrelated");
  });
});
