import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.ts";
import { writeCredentials } from "../src/config.ts";
import {
  cleanupCliDirectories,
  makeCliCapture,
  sendEnvelope,
  startOrganizationCliServer,
} from "./cli-test-support.ts";

afterEach(cleanupCliDirectories);

describe("stable artifact controls", () => {
  it("gets, independently authorizes, and idempotently deletes an owned artifact", async () => {
    const requests: Array<{ readonly method?: string; readonly url?: string }> = [];
    const server = await startOrganizationCliServer((request, response) => {
      requests.push({
        ...(request.method === undefined ? {} : { method: request.method }),
        ...(request.url === undefined ? {} : { url: request.url }),
      });
      if (request.url?.endsWith("/authorize") === true) {
        sendEnvelope(
          response,
          {
            organizationId: "org-1",
            artifact: descriptor(server.url),
            download: {
              expiresAt: "2026-07-11T12:05:00.000Z",
              method: "GET",
              url: `${server.url}/v1/artifacts/artifact-1/token/video.webm`,
            },
          },
          201,
        );
        return;
      }
      if (request.method === "DELETE") {
        sendEnvelope(response, {
          organizationId: "org-1",
          artifactId: "artifact-1",
          deleted: true,
          deletedAt: "2026-07-11T12:00:00.000Z",
        });
        return;
      }
      sendEnvelope(response, descriptor(server.url));
    });

    for (const command of ["get", "authorize", "delete"] as const) {
      const capture = await authenticatedCapture(server.url);
      expect(
        await runCli(
          ["--json", "--api-url", server.url, "artifacts", command, "artifact-1"],
          capture.dependencies,
        ),
      ).toBe(0);
      expect(capture.stdout().trim().split("\n")).toHaveLength(1);
    }
    await server.close();

    expect(requests).toEqual([
      { method: "GET", url: "/v1/organizations/org-1/artifacts/artifact-1" },
      { method: "POST", url: "/v1/organizations/org-1/artifacts/artifact-1/authorize" },
      { method: "DELETE", url: "/v1/organizations/org-1/artifacts/artifact-1" },
    ]);
  });
});

describe("artifact ID downloads", () => {
  it("authorizes an artifact ID just in time and verifies both bytes and SHA-256", async () => {
    const content = Buffer.from("verified artifact bytes");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const authorizationHeaders: Array<string | undefined> = [];
    const downloadHeaders: Array<string | undefined> = [];
    const server = await startOrganizationCliServer((request, response) => {
      if (request.url?.endsWith("/authorize") === true) {
        authorizationHeaders.push(request.headers.authorization);
        sendEnvelope(
          response,
          {
            organizationId: "org-1",
            artifact: descriptor(server.url, { bytes: content.length, sha256 }),
            download: {
              expiresAt: "2026-07-11T12:05:00.000Z",
              method: "GET",
              url: `${server.url}/download?token=independent`,
            },
          },
          201,
        );
        return;
      }
      downloadHeaders.push(request.headers.authorization);
      response.end(content);
    });
    const capture = await authenticatedCapture(server.url);
    const outputPath = join(capture.directory, "video.webm");

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
    expect(authorizationHeaders).toEqual(["Bearer access"]);
    expect(downloadHeaders).toEqual([undefined]);
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
});

describe("artifact ID verification failures", () => {
  it("removes a staged ID download when the declared byte count does not match", async () => {
    const content = Buffer.from("short");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const server = await startOrganizationCliServer((request, response) => {
      if (request.url?.endsWith("/authorize") === true) {
        sendEnvelope(
          response,
          {
            organizationId: "org-1",
            artifact: descriptor(server.url, { bytes: content.length + 1, sha256 }),
            download: {
              expiresAt: "2026-07-11T12:05:00.000Z",
              method: "GET",
              url: `${server.url}/download?token=independent`,
            },
          },
          201,
        );
        return;
      }
      response.end(content);
    });
    const capture = await authenticatedCapture(server.url);
    const outputPath = join(capture.directory, "video.webm");

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

    expect(exitCode).toBe(5);
    expect(JSON.parse(capture.stderr().trim().split("\n").at(-1) ?? "{}").code).toBe(
      "ARTIFACT_SIZE_MISMATCH",
    );
    expect((await readdir(capture.directory)).filter((name) => name.includes(".tmp"))).toEqual([]);
  });
});

const descriptor = (
  apiUrl: string,
  overrides: { readonly bytes?: number; readonly sha256?: string } = {},
) => ({
  organizationId: "org-1",
  authorizeUrl: `${apiUrl}/v1/organizations/org-1/artifacts/artifact-1/authorize`,
  availability: "available",
  bytes: overrides.bytes ?? 23,
  deleteUrl: `${apiUrl}/v1/organizations/org-1/artifacts/artifact-1`,
  filename: "video.webm",
  id: "artifact-1",
  kind: "video",
  mediaType: "video/webm",
  retainedUntil: "2026-07-12T12:00:00.000Z",
  sha256: overrides.sha256 ?? "a".repeat(64),
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
