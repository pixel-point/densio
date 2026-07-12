import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.ts";
import { cleanupCliDirectories, makeCliCapture, startCliServer } from "./cli-test-support.ts";

afterEach(cleanupCliDirectories);

describe("artifact download command", () => {
  it("streams to an atomic output and verifies the declared SHA-256", async () => {
    const capture = await makeCliCapture();
    const content = Buffer.from("verified artifact bytes");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const server = await startCliServer((_request, response) => {
      response.end(content);
    });
    const outputPath = join(capture.directory, "downloads", "video.webm");

    const exitCode = await runCli(
      [
        "--json",
        "--api-url",
        server.url,
        "artifacts",
        "download",
        `${server.url}/video.webm?token=signed`,
        "--output",
        outputPath,
        "--sha256",
        sha256,
      ],
      capture.dependencies,
    );
    await server.close();

    expect(exitCode).toBe(0);
    await expect(readFile(outputPath)).resolves.toEqual(content);
    expect(JSON.parse(capture.stdout()).data).toEqual({
      bytes: content.length,
      path: outputPath,
      sha256,
    });
  });

  it("deletes the temporary output and fails on a digest mismatch", async () => {
    const capture = await makeCliCapture();
    const server = await startCliServer((_request, response) => {
      response.end("wrong bytes");
    });
    const outputPath = join(capture.directory, "video.webm");
    await writeFile(outputPath, "existing destination");

    const exitCode = await runCli(
      [
        "--json",
        "--api-url",
        server.url,
        "artifacts",
        "download",
        `${server.url}/video.webm`,
        "--output",
        outputPath,
        "--sha256",
        "a".repeat(64),
        "--force",
      ],
      capture.dependencies,
    );
    await server.close();

    expect(exitCode).toBe(5);
    expect(JSON.parse(capture.stderr()).code).toBe("ARTIFACT_HASH_MISMATCH");
    await expect(readFile(outputPath, "utf8")).resolves.toBe("existing destination");
    expect((await readdir(capture.directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("artifact publication safety", () => {
  it.each([
    {
      expectedContent: "existing destination",
      expectedExitCode: 5,
      flags: [] as ReadonlyArray<string>,
      name: "preserves an existing destination by default",
    },
    {
      expectedContent: "replacement bytes",
      expectedExitCode: 0,
      flags: ["--force"],
      name: "atomically replaces an existing destination with --force",
    },
  ])("$name", async ({ expectedContent, expectedExitCode, flags }) => {
    const capture = await makeCliCapture();
    const replacement = Buffer.from("replacement bytes");
    const sha256 = createHash("sha256").update(replacement).digest("hex");
    const server = await startCliServer((_request, response) => {
      response.end(replacement);
    });
    const outputPath = join(capture.directory, "video.webm");
    await writeFile(outputPath, "existing destination");

    const exitCode = await runCli(
      [
        "--json",
        "artifacts",
        "download",
        `${server.url}/video.webm`,
        "--output",
        outputPath,
        "--sha256",
        sha256,
        ...flags,
      ],
      capture.dependencies,
    );
    await server.close();

    expect(exitCode).toBe(expectedExitCode);
    await expect(readFile(outputPath, "utf8")).resolves.toBe(expectedContent);
    expect((await readdir(capture.directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    if (expectedExitCode !== 0) {
      expect(JSON.parse(capture.stderr()).code).toBe("ARTIFACT_DESTINATION_EXISTS");
    }
  });

  it("rejects an artifact ID because downloads require the signed result URL", async () => {
    const capture = await makeCliCapture();

    const exitCode = await runCli(
      [
        "--json",
        "artifacts",
        "download",
        "artifact-1",
        "--output",
        join(capture.directory, "video.webm"),
        "--sha256",
        "a".repeat(64),
      ],
      capture.dependencies,
    );

    expect(exitCode).toBe(2);
    expect(JSON.parse(capture.stderr()).detail).toContain("signed HTTP(S) download URL");
  });
});
