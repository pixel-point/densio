import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupSourceWorkspace,
  makeSourceStoragePaths,
  prepareSourceWorkspace,
  resolveSourceStagedFile,
  type SourceStoragePaths,
} from "../src/storage/source-workspace.ts";

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("prepared source storage paths", () => {
  it("derives the branded contained source layout", async () => {
    const mediaRoot = await temporaryDirectory();
    const paths = await Effect.runPromise(makeSourceStoragePaths(mediaRoot, "source-123"));

    expect(paths).toMatchObject({
      mediaRoot: resolve(mediaRoot),
      workspaceDirectory: resolve(mediaRoot, "sources", "source-123"),
      inputFile: resolve(mediaRoot, "sources", "source-123", "input", "source-video"),
      stagingDirectory: resolve(mediaRoot, "sources", "source-123", "staging"),
    });
    expect(Object.isFrozen(paths)).toBe(true);
  });

  it("rejects unsafe source IDs and staged filenames", async () => {
    const mediaRoot = await temporaryDirectory();

    await expect(
      Effect.runPromise(makeSourceStoragePaths(mediaRoot, "../other-source")),
    ).rejects.toMatchObject({ _tag: "InvalidStoragePath" });
    const paths = await Effect.runPromise(makeSourceStoragePaths(mediaRoot, "source-123"));
    await expect(
      Effect.runPromise(resolveSourceStagedFile(paths, "../input/source-video")),
    ).rejects.toMatchObject({ _tag: "InvalidStoragePath" });
  });
});

describe("prepared source workspace lifecycle", () => {
  it("prepares and idempotently cleans only the source workspace", async () => {
    const mediaRoot = await temporaryDirectory();
    const unrelated = join(mediaRoot, "unrelated.txt");
    await writeFile(unrelated, "keep");
    const paths = await Effect.runPromise(makeSourceStoragePaths(mediaRoot, "source-123"));

    await Effect.runPromise(prepareSourceWorkspace(paths));
    await expect(access(join(paths.workspaceDirectory, "input"))).resolves.toBeUndefined();
    await expect(access(paths.stagingDirectory)).resolves.toBeUndefined();

    await Effect.runPromise(cleanupSourceWorkspace(paths));
    await Effect.runPromise(cleanupSourceWorkspace(paths));

    await expect(access(paths.workspaceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(unrelated)).resolves.toBeUndefined();
  });

  it("rejects a forged paths object before deleting anything", async () => {
    const mediaRoot = await temporaryDirectory();
    const unrelatedDirectory = join(mediaRoot, "unrelated");
    const legitimate = await Effect.runPromise(makeSourceStoragePaths(mediaRoot, "source-123"));
    const forged = { ...legitimate, workspaceDirectory: unrelatedDirectory } as SourceStoragePaths;
    await Effect.runPromise(prepareSourceWorkspace(legitimate));
    await writeFile(join(legitimate.stagingDirectory, "marker"), "keep");

    await expect(Effect.runPromise(cleanupSourceWorkspace(forged))).rejects.toMatchObject({
      _tag: "InvalidStoragePath",
    });
    await expect(access(join(legitimate.stagingDirectory, "marker"))).resolves.toBeUndefined();
  });
});

const temporaryDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "densio-source-workspace-"));
  temporaryDirectories.push(directory);
  return directory;
};
