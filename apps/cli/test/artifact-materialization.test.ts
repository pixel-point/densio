import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { successfulCompressionJob } from "./canonical-fixtures.ts";

import { runCli } from "../src/cli.ts";
import { publishOutputBundle } from "../src/local-output.ts";
import { writeCredentials } from "../src/config.ts";
import {
  cleanupCliDirectories,
  makeCliCapture,
  sendEnvelope,
  startOrganizationCliServer,
} from "./cli-test-support.ts";

afterEach(cleanupCliDirectories);

describe("artifact materialization", () => {
  it("restores forced backups when a target changes after preflight", async () => {
    const capture = await makeCliCapture();
    const directory = join(await realpath(capture.directory), "rollback");
    await mkdir(directory);
    const firstTarget = join(directory, "first.webm");
    const firstTemporary = join(directory, ".first.tmp");
    const secondTarget = join(directory, "second.mp4");
    const secondTemporary = join(directory, ".second.tmp");
    const linkDestination = join(directory, "link-destination");
    await writeFile(firstTarget, "original first");
    await writeFile(firstTemporary, "replacement first");
    await writeFile(secondTemporary, "replacement second");
    await writeFile(linkDestination, "do not replace");
    await symlink(linkDestination, secondTarget);

    await expect(
      publishOutputBundle(
        [
          { targetPath: firstTarget, temporaryPath: firstTemporary },
          { targetPath: secondTarget, temporaryPath: secondTemporary },
        ],
        true,
      ),
    ).rejects.toThrow();

    await expect(readFile(firstTarget, "utf8")).resolves.toBe("original first");
    await expect(readFile(linkDestination, "utf8")).resolves.toBe("do not replace");
    expect((await readdir(directory)).filter((name) => name.includes(".bak"))).toEqual([]);
  });
});

it("authorizes each artifact just in time, verifies it, and writes relative HTML and a manifest", async () => {
  const contents = new Map([
    ["artifact-vp9", Buffer.from("vp9 bytes")],
    ["artifact-h265", Buffer.from("h265 bytes")],
  ]);
  const requests: Array<string> = [];
  const server = await startOrganizationCliServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.url === "/v1/organizations/org-1/jobs/job-1") {
      sendEnvelope(response, compressionJob(server.url, contents));
      return;
    }
    const artifactId = request.url?.match(/\/v1\/organizations\/org-1\/artifacts\/([^/]+)/)?.[1];
    if (artifactId !== undefined && request.url?.endsWith("/authorize") === true) {
      sendEnvelope(
        response,
        {
          organizationId: "org-1",
          artifact: artifactDescriptor(
            server.url,
            artifactId,
            contents.get(artifactId) ?? Buffer.alloc(0),
          ),
          download: {
            expiresAt: "2026-07-11T12:05:00.000Z",
            method: "GET",
            url: `${server.url}/downloads/${artifactId}?token=secret-${artifactId}`,
          },
        },
        201,
      );
      return;
    }
    if (artifactId !== undefined) {
      sendEnvelope(
        response,
        artifactDescriptor(server.url, artifactId, contents.get(artifactId) ?? Buffer.alloc(0)),
      );
      return;
    }
    const downloadId = request.url?.match(/\/downloads\/([^?]+)/)?.[1];
    response.end(contents.get(downloadId ?? "") ?? Buffer.alloc(0));
  });
  const capture = await authenticatedCapture(server.url);
  const outputDirectory = join(await realpath(capture.directory), "public", "media");

  const exitCode = await runCli(
    [
      "--json",
      "--api-url",
      server.url,
      "artifacts",
      "materialize",
      "job-1",
      "--output-dir",
      outputDirectory,
    ],
    capture.dependencies,
  );
  await server.close();

  expect({ exitCode, stderr: capture.stderr() }).toEqual({
    exitCode: 0,
    stderr: `${JSON.stringify({ type: "organization-selected", organizationId: "org-1", name: "Team" })}\n`,
  });
  await expect(readFile(join(outputDirectory, "hero-vp9.webm"))).resolves.toEqual(
    contents.get("artifact-vp9"),
  );
  await expect(readFile(join(outputDirectory, "hero-h265.mp4"))).resolves.toEqual(
    contents.get("artifact-h265"),
  );
  const html = await readFile(join(outputDirectory, "index.html"), "utf8");
  expect(html).toContain('src="./hero-vp9.webm"');
  expect(html).toContain('src="./hero-h265.mp4"');
  expect(html).not.toContain("token=");
  expect(
    JSON.parse(await readFile(join(outputDirectory, "densio-manifest.json"), "utf8")),
  ).toMatchObject({
    artifacts: [
      { artifactId: "artifact-vp9", filename: "hero-vp9.webm" },
      { artifactId: "artifact-h265", filename: "hero-h265.mp4" },
    ],
    html: "index.html",
    jobId: "job-1",
    schemaVersion: 1,
  });
  expect(requests).toEqual([
    "GET /v1/organizations/org-1/jobs/job-1",
    "POST /v1/organizations/org-1/artifacts/artifact-vp9/authorize",
    "GET /downloads/artifact-vp9?token=secret-artifact-vp9",
    "POST /v1/organizations/org-1/artifacts/artifact-h265/authorize",
    "GET /downloads/artifact-h265?token=secret-artifact-h265",
  ]);
  expect(capture.stdout().trim().split("\n")).toHaveLength(1);
  expectMaterializationReceipt(capture.stdout(), outputDirectory);
  expect(JSON.parse(capture.stderr())).toMatchObject({
    type: "organization-selected",
    organizationId: "org-1",
  });
});

it("materializes only artifacts currently marked available by job status", async () => {
  const contents = new Map([
    ["artifact-vp9", Buffer.from("available bytes")],
    ["artifact-h265", Buffer.from("deleted bytes")],
  ]);
  const requests: Array<string> = [];
  const server = await startOrganizationCliServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.url === "/v1/organizations/org-1/jobs/job-1") {
      const status = compressionJob(server.url, contents);
      sendEnvelope(response, {
        ...status,
        artifacts: status.artifacts.map((artifact) =>
          artifact.id === "artifact-h265"
            ? { ...artifact, availability: "deleted" as const }
            : artifact,
        ),
      });
      return;
    }
    const artifactId = request.url?.match(/\/v1\/organizations\/org-1\/artifacts\/([^/]+)/)?.[1];
    if (artifactId !== undefined && request.url?.endsWith("/authorize") === true) {
      sendEnvelope(
        response,
        {
          organizationId: "org-1",
          artifact: artifactDescriptor(
            server.url,
            artifactId,
            contents.get(artifactId) ?? Buffer.alloc(0),
          ),
          download: {
            expiresAt: "2026-07-11T12:05:00.000Z",
            method: "GET",
            url: `${server.url}/downloads/${artifactId}`,
          },
        },
        201,
      );
      return;
    }
    if (artifactId !== undefined) {
      sendEnvelope(
        response,
        artifactDescriptor(server.url, artifactId, contents.get(artifactId) ?? Buffer.alloc(0)),
      );
      return;
    }
    const downloadId = request.url?.match(/\/downloads\/([^?]+)/)?.[1];
    response.end(contents.get(downloadId ?? "") ?? Buffer.alloc(0));
  });
  const capture = await authenticatedCapture(server.url);
  const outputDirectory = join(await realpath(capture.directory), "current");

  const exitCode = await runCli(
    [
      "--json",
      "--api-url",
      server.url,
      "artifacts",
      "materialize",
      "job-1",
      "--output-dir",
      outputDirectory,
    ],
    capture.dependencies,
  );
  await server.close();

  expect(exitCode).toBe(0);
  await expect(readFile(join(outputDirectory, "hero-vp9.webm"))).resolves.toEqual(
    contents.get("artifact-vp9"),
  );
  await expect(readFile(join(outputDirectory, "hero-h265.mp4"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(requests.some((request) => request.includes("artifact-h265"))).toBe(false);
});

it("refuses materialization when the job has no currently available artifacts", async () => {
  const content = Buffer.from("deleted bytes");
  const requests: Array<string> = [];
  const server = await startOrganizationCliServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.url === "/v1/organizations/org-1/jobs/job-1") {
      const status = compressionJob(server.url, new Map([["artifact-vp9", content]]));
      sendEnvelope(response, {
        ...status,
        artifacts: status.artifacts.map((artifact) => ({
          ...artifact,
          availability: "deleted" as const,
        })),
      });
      return;
    }
    sendEnvelope(response, artifactDescriptor(server.url, "artifact-vp9", content));
  });
  const capture = await authenticatedCapture(server.url);

  const exitCode = await runCli(
    [
      "--json",
      "--api-url",
      server.url,
      "artifacts",
      "materialize",
      "job-1",
      "--output-dir",
      join(await realpath(capture.directory), "unavailable"),
    ],
    capture.dependencies,
  );
  await server.close();

  expect(exitCode).toBe(5);
  expect(JSON.parse(capture.stderr().trim().split("\n").at(-1) ?? "{}")).toMatchObject({
    code: "ARTIFACT_OUTPUT_UNSAFE",
  });
  expect(requests).toEqual(["GET /v1/organizations/org-1/jobs/job-1"]);
});

describe("materialization preflight", () => {
  it.each([
    {
      filenames: ["same.webm", "same.webm"],
      name: "duplicate artifact names",
    },
    {
      filenames: ["index.html", "hero.mp4"],
      name: "a generated HTML collision",
    },
    {
      filenames: ["hero.webm\u0000", "hero.mp4"],
      name: "a control character",
    },
  ])("rejects $name before authorizing downloads", async ({ filenames, name }) => {
    let authorizations = 0;
    const contents = new Map([
      ["artifact-vp9", Buffer.from("vp9 bytes")],
      ["artifact-h265", Buffer.from("h265 bytes")],
    ]);
    const server = await startOrganizationCliServer((request, response) => {
      if (request.url === "/v1/organizations/org-1/jobs/job-1") {
        const status = compressionJob(server.url, contents);
        sendEnvelope(response, {
          ...status,
          artifacts: status.artifacts.map((artifact, index) => ({
            ...artifact,
            filename: filenames[index],
          })),
        });
        return;
      }
      const artifactId =
        request.url?.match(/\/v1\/organizations\/org-1\/artifacts\/([^/]+)/)?.[1] ?? "artifact-vp9";
      if (request.url?.endsWith("/authorize") === true) authorizations += 1;
      const index = artifactId === "artifact-vp9" ? 0 : 1;
      sendEnvelope(response, {
        ...artifactDescriptor(server.url, artifactId, contents.get(artifactId) ?? Buffer.alloc(0)),
        filename: filenames[index],
      });
    });
    const capture = await authenticatedCapture(server.url);

    const exitCode = await runCli(
      [
        "--json",
        "--api-url",
        server.url,
        "artifacts",
        "materialize",
        "job-1",
        "--output-dir",
        join(await realpath(capture.directory), "output"),
      ],
      capture.dependencies,
    );
    await server.close();

    expect(exitCode).toBe(5);
    expect(JSON.parse(capture.stderr().trim().split("\n").at(-1) ?? "{}").code).toBe(
      name === "a control character" ? "CLI_INVALID_RESPONSE" : "ARTIFACT_OUTPUT_UNSAFE",
    );
    expect(authorizations).toBe(0);
  });
});

describe("materialization filesystem boundaries", () => {
  it("rejects a symlinked output component before authorizing downloads", async () => {
    const content = Buffer.from("vp9 bytes");
    let authorizations = 0;
    const server = await startOrganizationCliServer((request, response) => {
      if (request.url === "/v1/organizations/org-1/jobs/job-1") {
        sendEnvelope(response, compressionJob(server.url, new Map([["artifact-vp9", content]])));
        return;
      }
      if (request.url?.endsWith("/authorize") === true) authorizations += 1;
      sendEnvelope(response, artifactDescriptor(server.url, "artifact-vp9", content));
    });
    const capture = await authenticatedCapture(server.url);
    const captureDirectory = await realpath(capture.directory);
    const realDirectory = join(captureDirectory, "real-output");
    const linkedDirectory = join(captureDirectory, "linked-output");
    await mkdir(realDirectory);
    await symlink(realDirectory, linkedDirectory);

    const exitCode = await runCli(
      [
        "--json",
        "--api-url",
        server.url,
        "artifacts",
        "materialize",
        "job-1",
        "--output-dir",
        linkedDirectory,
      ],
      capture.dependencies,
    );
    await server.close();

    expect(exitCode).toBe(5);
    expect(JSON.parse(capture.stderr().trim().split("\n").at(-1) ?? "{}").code).toBe(
      "ARTIFACT_OUTPUT_UNSAFE",
    );
    expect(authorizations).toBe(0);
  });
});

describe("materialization failure recovery", () => {
  it("preserves existing outputs by default and replaces them with --force", async () => {
    const content = Buffer.from("replacement bytes");
    const server = await materializationServer(content);
    const capture = await authenticatedCapture(server.url);
    const outputDirectory = join(await realpath(capture.directory), "output");
    const outputPath = join(outputDirectory, "hero-vp9.webm");
    await mkdir(outputDirectory);
    await writeFile(outputPath, "existing bytes");

    const defaultExitCode = await runCli(
      [
        "--json",
        "--api-url",
        server.url,
        "artifacts",
        "materialize",
        "job-1",
        "--output-dir",
        outputDirectory,
      ],
      capture.dependencies,
    );
    expect(defaultExitCode).toBe(5);
    await expect(readFile(outputPath, "utf8")).resolves.toBe("existing bytes");

    const forcedCapture = await authenticatedCapture(server.url);
    const forcedExitCode = await runCli(
      [
        "--json",
        "--api-url",
        server.url,
        "artifacts",
        "materialize",
        "job-1",
        "--output-dir",
        outputDirectory,
        "--force",
      ],
      forcedCapture.dependencies,
    );
    expect({ exitCode: forcedExitCode, stderr: forcedCapture.stderr() }).toEqual({
      exitCode: 0,
      stderr: `${JSON.stringify({ type: "organization-selected", organizationId: "org-1", name: "Team" })}\n`,
    });
    await server.close();

    await expect(readFile(outputPath)).resolves.toEqual(content);
    expect((await readdir(outputDirectory)).filter((name) => name.includes(".densio-"))).toEqual(
      [],
    );
  });
});

describe("materialization staging recovery", () => {
  it("removes every temporary and publishes nothing when a later download fails verification", async () => {
    const first = Buffer.from("first verified");
    const second = Buffer.from("second corrupted");
    const declaredSecond = Buffer.from("second expected");
    const contents = new Map([
      ["artifact-vp9", first],
      ["artifact-h265", declaredSecond],
    ]);
    const server = await startOrganizationCliServer((request, response) => {
      if (request.url === "/v1/organizations/org-1/jobs/job-1") {
        sendEnvelope(response, compressionJob(server.url, contents));
        return;
      }
      const artifactId = request.url?.match(/\/v1\/organizations\/org-1\/artifacts\/([^/]+)/)?.[1];
      if (artifactId !== undefined && request.url?.endsWith("/authorize") === true) {
        sendEnvelope(
          response,
          {
            organizationId: "org-1",
            artifact: artifactDescriptor(
              server.url,
              artifactId,
              contents.get(artifactId) ?? Buffer.alloc(0),
            ),
            download: {
              expiresAt: "2026-07-11T12:05:00.000Z",
              method: "GET",
              url: `${server.url}/downloads/${artifactId}`,
            },
          },
          201,
        );
        return;
      }
      if (artifactId !== undefined) {
        sendEnvelope(
          response,
          artifactDescriptor(server.url, artifactId, contents.get(artifactId) ?? Buffer.alloc(0)),
        );
        return;
      }
      response.end(request.url?.includes("artifact-vp9") === true ? first : second);
    });
    const capture = await authenticatedCapture(server.url);
    const outputDirectory = join(await realpath(capture.directory), "output");

    const exitCode = await runCli(
      [
        "--json",
        "--api-url",
        server.url,
        "artifacts",
        "materialize",
        "job-1",
        "--output-dir",
        outputDirectory,
      ],
      capture.dependencies,
    );
    await server.close();

    expect(exitCode).toBe(5);
    await expect(readdir(outputDirectory)).resolves.toEqual([]);
  });
});

describe("materialization interruption", () => {
  it("removes partial files and leaves the remote artifact available", async () => {
    const content = Buffer.from("complete artifact bytes");
    const controller = new AbortController();
    let deleteRequests = 0;
    const server = await startOrganizationCliServer((request, response) => {
      if (request.method === "DELETE") deleteRequests += 1;
      if (request.url === "/v1/organizations/org-1/jobs/job-1") {
        sendEnvelope(response, compressionJob(server.url, new Map([["artifact-vp9", content]])));
        return;
      }
      if (request.url === "/v1/organizations/org-1/artifacts/artifact-vp9") {
        sendEnvelope(response, artifactDescriptor(server.url, "artifact-vp9", content));
        return;
      }
      if (request.url?.endsWith("/authorize") === true) {
        sendEnvelope(
          response,
          {
            organizationId: "org-1",
            artifact: artifactDescriptor(server.url, "artifact-vp9", content),
            download: {
              expiresAt: "2026-07-11T12:05:00.000Z",
              method: "GET",
              url: `${server.url}/download`,
            },
          },
          201,
        );
        return;
      }
      response.write(content.subarray(0, 3));
      controller.abort();
      setTimeout(() => response.end(content.subarray(3)), 10);
    });
    const capture = await authenticatedCapture(server.url);
    const outputDirectory = join(await realpath(capture.directory), "interrupted");

    const exitCode = await runCli(
      [
        "--json",
        "--api-url",
        server.url,
        "artifacts",
        "materialize",
        "job-1",
        "--output-dir",
        outputDirectory,
      ],
      { ...capture.dependencies, signal: controller.signal },
    );
    await server.close();

    expect(exitCode).toBe(130);
    expect(JSON.parse(capture.stderr().trim().split("\n").at(-1) ?? "{}").code).toBe(
      "CLI_INTERRUPTED",
    );
    await expect(readdir(outputDirectory)).resolves.toEqual([]);
    expect(deleteRequests).toBe(0);
  });
});

const expectMaterializationReceipt = (stdout: string, outputDirectory: string) => {
  expect(JSON.parse(stdout).data).toMatchObject({
    htmlPath: join(outputDirectory, "index.html"),
    job: { id: "job-1", state: "succeeded" },
    jobId: "job-1",
    manifestPath: join(outputDirectory, "densio-manifest.json"),
    outputDirectory,
  });
};

const materializationServer = async (content: Buffer) => {
  let apiUrl = "";
  const server = await startOrganizationCliServer((request, response) => {
    if (request.url === "/v1/organizations/org-1/jobs/job-1") {
      sendEnvelope(response, compressionJob(apiUrl, new Map([["artifact-vp9", content]])));
      return;
    }
    if (request.url === "/v1/organizations/org-1/artifacts/artifact-vp9") {
      sendEnvelope(response, artifactDescriptor(apiUrl, "artifact-vp9", content));
      return;
    }
    if (request.url?.endsWith("/authorize") === true) {
      sendEnvelope(
        response,
        {
          organizationId: "org-1",
          artifact: artifactDescriptor(apiUrl, "artifact-vp9", content),
          download: {
            expiresAt: "2026-07-11T12:05:00.000Z",
            method: "GET",
            url: `${apiUrl}/download`,
          },
        },
        201,
      );
      return;
    }
    response.end(content);
  });
  apiUrl = server.url;
  return server;
};

const compressionJob = (apiUrl: string, contents: ReadonlyMap<string, Buffer>) =>
  successfulCompressionJob(
    [...contents].map(([artifactId, content]) => artifactDescriptor(apiUrl, artifactId, content)),
  );

const artifactDescriptor = (apiUrl: string, artifactId: string, content: Buffer) => ({
  ...artifactFacts(artifactId, content),
  organizationId: "org-1",
  authorizeUrl: `${apiUrl}/v1/organizations/org-1/artifacts/${artifactId}/authorize`,
  availability: "available" as const,
  deleteUrl: `${apiUrl}/v1/organizations/org-1/artifacts/${artifactId}`,
  retainedUntil: "2026-07-12T12:00:00.000Z",
});

const artifactFacts = (artifactId: string, content: Buffer) => ({
  bytes: content.length,
  codec: artifactId === "artifact-vp9" ? ("vp9" as const) : ("h265" as const),
  filename: artifactId === "artifact-vp9" ? "hero-vp9.webm" : "hero-h265.mp4",
  id: artifactId,
  kind: "video" as const,
  mediaType: artifactId === "artifact-vp9" ? "video/webm" : "video/mp4",
  sha256: createHash("sha256").update(content).digest("hex"),
});

const authenticatedCapture = async (apiUrl: string) => {
  const capture = await makeCliCapture();
  await writeCredentials(capture.dependencies.credentialsPath, {
    accessToken: "access",
    accessTokenExpiresAt: "2026-07-11T14:00:00.000Z",
    apiUrl,
    refreshToken: "refresh",
  });
  return capture;
};
