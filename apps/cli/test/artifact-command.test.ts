import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeCredentials } from "../src/config.ts";

import { runCli } from "../src/cli.ts";
import {
  cleanupCliDirectories,
  makeCliCapture,
  sendEnvelope,
  startOrganizationCliServer,
} from "./cli-test-support.ts";

afterEach(cleanupCliDirectories);

describe("artifact download command", () => {
  it("streams to an atomic output and verifies the declared SHA-256", async () => {
    const capture = await makeCliCapture();
    const content = Buffer.from("verified artifact bytes");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const server = await downloadServer(content, sha256);
    await authenticate(capture, server.url);
    const outputPath = join(capture.directory, "downloads", "video.webm");

    const exitCode = await runCli(
      [
        "--json",
        "--api-url",
        server.url,
        "artifacts",
        "download",
        "artifact-1",
        "--output",
        outputPath,
      ],
      capture.dependencies,
    );
    await server.close();

    expect(exitCode).toBe(0);
    await expect(readFile(outputPath)).resolves.toEqual(content);
    expect(JSON.parse(capture.stdout()).data).toEqual({
      organizationId: "org-1",
      artifactId: "artifact-1",
      bytes: content.length,
      path: outputPath,
      sha256,
      verified: true,
    });
  });

  it("deletes the temporary output and fails on a digest mismatch", async () => {
    const capture = await makeCliCapture();
    const server = await downloadServer(Buffer.from("wrong bytes"), "a".repeat(64));
    await authenticate(capture, server.url);
    const outputPath = join(capture.directory, "video.webm");
    await writeFile(outputPath, "existing destination");

    const exitCode = await runCli(
      [
        "--json",
        "--api-url",
        server.url,
        "artifacts",
        "download",
        "artifact-1",
        "--output",
        outputPath,
        "--force",
      ],
      capture.dependencies,
    );
    await server.close();

    expect(exitCode).toBe(5);
    expect(JSON.parse(capture.stderr().trim().split("\n").at(-1) ?? "{}").code).toBe(
      "ARTIFACT_HASH_MISMATCH",
    );
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
    const server = await downloadServer(replacement, sha256);
    await authenticate(capture, server.url);
    const outputPath = join(capture.directory, "video.webm");
    await writeFile(outputPath, "existing destination");

    const exitCode = await runCli(
      [
        "--json",
        "--api-url",
        server.url,
        "artifacts",
        "download",
        "artifact-1",
        "--output",
        outputPath,
        ...flags,
      ],
      capture.dependencies,
    );
    await server.close();

    expect(exitCode).toBe(expectedExitCode);
    await expect(readFile(outputPath, "utf8")).resolves.toBe(expectedContent);
    expect((await readdir(capture.directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    if (expectedExitCode !== 0) {
      expect(JSON.parse(capture.stderr().trim().split("\n").at(-1) ?? "{}").code).toBe(
        "ARTIFACT_DESTINATION_EXISTS",
      );
    }
  });
});

const authenticate = (capture: Awaited<ReturnType<typeof makeCliCapture>>, apiUrl: string) =>
  writeCredentials(capture.dependencies.credentialsPath, {
    accessToken: "access",
    refreshToken: "refresh",
    accessTokenExpiresAt: "2026-07-11T14:00:00.000Z",
    apiUrl,
  });

const downloadServer = async (content: Buffer, sha256: string) => {
  const server = await startOrganizationCliServer((request, response) => {
    if (request.url?.endsWith("/authorize")) {
      sendEnvelope(
        response,
        {
          organizationId: "org-1",
          artifact: {
            organizationId: "org-1",
            id: "artifact-1",
            filename: "video.webm",
            kind: "video",
            mediaType: "video/webm",
            bytes: content.length,
            sha256,
            availability: "available",
            retainedUntil: "2026-07-12T12:00:00.000Z",
            authorizeUrl: `${server.url}/v1/organizations/org-1/artifacts/artifact-1/authorize`,
            deleteUrl: `${server.url}/v1/organizations/org-1/artifacts/artifact-1`,
          },
          download: {
            method: "GET",
            url: `${server.url}/download`,
            expiresAt: "2026-07-11T12:05:00.000Z",
          },
        },
        201,
      );
      return;
    }
    response.end(content);
  });
  return server;
};
