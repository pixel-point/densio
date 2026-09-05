import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { attachPreparedSource } from "../src/storage/source-attachment.ts";
import { makeJobStoragePaths, prepareJobWorkspace } from "../src/storage/workspace.ts";
import { makeSourceStoragePaths, prepareSourceWorkspace } from "../src/storage/source-workspace.ts";

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("prepared source job attachment", () => {
  it.each(["link", "copy"])("makes concurrent %s attachment retries safe", async (mode) => {
    const fixture = await sourceFixture("concurrent input");
    const attached = await Promise.all(
      Array.from({ length: 4 }, () =>
        Effect.runPromise(
          attachPreparedSource({
            expected: fixture.expected,
            jobId: "concurrent",
            mediaRoot: fixture.mediaRoot,
            sourceId: "source-1",
            ...(mode === "copy" ? { linkFile: crossDeviceLink } : {}),
          }),
        ),
      ),
    );
    expect(attached).toHaveLength(4);
    expect(await readFile(attached[0]?.inputFile ?? "", "utf8")).toBe("concurrent input");
  });

  it("hard-links verified bytes into a contained job workspace", async () => {
    const fixture = await sourceFixture("hello");

    const attached = await Effect.runPromise(
      attachPreparedSource({
        expected: fixture.expected,
        jobId: "job-1",
        mediaRoot: fixture.mediaRoot,
        sourceId: "source-1",
      }),
    );

    expect(attached).toMatchObject({ ...fixture.expected, inputMode: "hard-link" });
    expect(await readFile(attached.inputFile, "utf8")).toBe("hello");
    expect((await stat(attached.inputFile)).ino).toBe((await stat(fixture.sourceInput)).ino);
  });

  it("falls back to a verified exclusive copy when linking crosses a device", async () => {
    const fixture = await sourceFixture("copy me");

    const attached = await Effect.runPromise(
      attachPreparedSource({
        expected: fixture.expected,
        jobId: "job-1",
        linkFile: crossDeviceLink,
        mediaRoot: fixture.mediaRoot,
        sourceId: "source-1",
      }),
    );

    expect(attached.inputMode).toBe("copy");
    expect(await readFile(attached.inputFile, "utf8")).toBe("copy me");
    expect((await stat(attached.inputFile)).ino).not.toBe((await stat(fixture.sourceInput)).ino);
  });

  it("rejects tampered source bytes and preserves an existing job input", async () => {
    const fixture = await sourceFixture("hello");
    await writeFile(fixture.sourceInput, "tampered");

    await expect(
      Effect.runPromise(
        attachPreparedSource({
          expected: fixture.expected,
          jobId: "job-1",
          mediaRoot: fixture.mediaRoot,
          sourceId: "source-1",
        }),
      ),
    ).rejects.toMatchObject({ _tag: "SourceAttachmentError" });

    const jobPaths = await Effect.runPromise(makeJobStoragePaths(fixture.mediaRoot, "job-2"));
    await Effect.runPromise(prepareJobWorkspace(jobPaths));
    await writeFile(jobPaths.inputFile, "existing");
    await writeFile(fixture.sourceInput, "hello");
    await expect(
      Effect.runPromise(
        attachPreparedSource({
          expected: fixture.expected,
          jobId: "job-2",
          mediaRoot: fixture.mediaRoot,
          sourceId: "source-1",
        }),
      ),
    ).rejects.toMatchObject({ _tag: "SourceAttachmentError" });
    expect(await readFile(jobPaths.inputFile, "utf8")).toBe("existing");
  });
});

const sourceFixture = async (contents: string) => {
  const mediaRoot = await mkdtemp(join(tmpdir(), "densio-source-attachment-"));
  temporaryDirectories.push(mediaRoot);
  const sourcePaths = await Effect.runPromise(makeSourceStoragePaths(mediaRoot, "source-1"));
  await Effect.runPromise(prepareSourceWorkspace(sourcePaths));
  await writeFile(sourcePaths.inputFile, contents);
  return {
    expected: {
      bytes: Buffer.byteLength(contents),
      sha256: createHash("sha256").update(contents).digest("hex"),
    },
    mediaRoot,
    sourceInput: sourcePaths.inputFile,
  };
};

const crossDeviceLink = async () => {
  const error = new Error("cross-device link");
  Object.assign(error, { code: "EXDEV" });
  throw error;
};
