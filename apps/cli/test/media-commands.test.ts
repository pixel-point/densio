import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";
import { runCli } from "../src/cli.ts";
import { writeCredentials } from "../src/config.ts";
import { successfulCompressionJob } from "./canonical-fixtures.ts";
import {
  cleanupCliDirectories,
  makeCliCapture,
  readRequestBody,
  sendEnvelope,
  startOrganizationCliServer,
} from "./cli-test-support.ts";

afterEach(cleanupCliDirectories);

it.each([true, false])(
  "executes a plan, acknowledges before polling, and materializes verified output (JSON %s)",
  async (json) => {
    const capture = await makeCliCapture();
    const content = Buffer.from("verified video");
    const requests: string[] = [];
    let acknowledgedBeforePolling = false;
    const server = await startOrganizationCliServer(async (request, response) => {
      requests.push(`${request.method} ${request.url}`);
      const artifact = {
        organizationId: "org-1",
        id: "artifact-1",
        filename: "video.webm",
        kind: "video" as const,
        mediaType: "video/webm",
        bytes: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
        retainedUntil: "2026-07-12T12:00:00.000Z",
        availability: "available" as const,
        authorizeUrl: `${server.url}/v1/organizations/org-1/artifacts/artifact-1/authorize`,
        deleteUrl: `${server.url}/v1/organizations/org-1/artifacts/artifact-1`,
      };
      if (request.url?.endsWith("/execute")) {
        expect(request.headers["idempotency-key"]).toBe("execute-1");
        expect(JSON.parse((await readRequestBody(request)).toString())).toEqual({});
        sendEnvelope(
          response,
          {
            jobId: "job-1",
            organizationId: "org-1",
            replayed: false,
            state: "preparing",
            statusUrl: `${server.url}/v1/organizations/org-1/jobs/job-1`,
          },
          201,
        );
        return;
      }
      if (request.url?.includes("/events")) {
        acknowledgedBeforePolling = capture.stderr().includes("job-1");
        sendEnvelope(response, { organizationId: "org-1", events: [], nextCursor: 0 });
        return;
      }
      if (request.url === "/v1/organizations/org-1/jobs/job-1") {
        sendEnvelope(response, successfulCompressionJob([artifact]));
        return;
      }
      if (request.url?.endsWith("/authorize")) {
        sendEnvelope(
          response,
          {
            artifact,
            organizationId: "org-1",
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
    await writeCredentials(capture.dependencies.credentialsPath, {
      accessToken: "access",
      refreshToken: "refresh",
      accessTokenExpiresAt: "2026-07-11T14:00:00.000Z",
      apiUrl: server.url,
    });
    const outputDirectory = join(await realpath(capture.directory), "output");
    const exitCode = await runCli(
      [
        ...(json ? ["--json"] : []),
        "--api-url",
        server.url,
        "plans",
        "execute",
        "plan-1",
        "--idempotency-key",
        "execute-1",
        "--output-dir",
        outputDirectory,
      ],
      capture.dependencies,
    );
    await server.close();
    expect(exitCode).toBe(0);
    expect(acknowledgedBeforePolling).toBe(true);
    expect(requests).not.toEqual(expect.arrayContaining([expect.stringContaining("/upload")]));
    await expect(readFile(join(outputDirectory, "video.webm"))).resolves.toEqual(content);
    const manifest = JSON.parse(
      await readFile(join(outputDirectory, "densio-manifest.json"), "utf8"),
    );
    expect(manifest.jobId).toBe("job-1");
    if (json) {
      expect(capture.stdout().trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(capture.stdout()).data).toMatchObject({ jobId: "job-1", outputDirectory });
    }
  },
);
