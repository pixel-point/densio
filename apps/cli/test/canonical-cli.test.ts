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

describe("canonical command surface", () => {
  it.each(["compress", "extract-images", "compare-quality"])(
    "rejects retired %s entrypoints",
    async (command) => {
      const capture = await makeCliCapture();
      expect(await runCli(["--json", command, "video.mp4"], capture.dependencies)).toBe(2);
      expect(capture.stderr()).toContain("Unknown command");
    },
  );

  it("lists sources using typed owner-scoped filters", async () => {
    const requests: string[] = [];
    const server = await startOrganizationCliServer((request, response) => {
      requests.push(request.url ?? "");
      sendEnvelope(response, { organizationId: "org-1", sources: [], nextCursor: "next+/=" });
    });
    const capture = await authenticatedCapture(server.url);
    const exitCode = await runCli(
      [
        "--json",
        "--api-url",
        server.url,
        "sources",
        "list",
        "--state",
        "deleted",
        "--limit",
        "10",
        "--cursor",
        "previous+/=",
      ],
      capture.dependencies,
    );
    await server.close();
    expect(exitCode).toBe(0);
    expect(Object.fromEntries(new URL(requests[0] ?? "", server.url).searchParams)).toEqual({
      state: "deleted",
      limit: "10",
      cursor: "previous+/=",
    });
    expect(JSON.parse(capture.stdout()).data).toEqual({
      organizationId: "org-1",
      sources: [],
      nextCursor: "next+/=",
    });
  });

  it("does not silently fall back when the events endpoint returns 404", async () => {
    const requests: string[] = [];
    const server = await startOrganizationCliServer((request, response) => {
      requests.push(request.url ?? "");
      response.writeHead(404, { "content-type": "application/problem+json" });
      response.end(
        JSON.stringify({
          type: "about:blank",
          title: "Not found",
          status: 404,
          detail: "Job not found.",
          code: "JOB_NOT_FOUND",
          retryable: false,
          suggestedAction: "Check the job ID.",
          correlationId: "test",
          schemaVersion: 1,
        }),
      );
    });
    const capture = await authenticatedCapture(server.url);
    const exitCode = await runCli(
      ["--json", "--api-url", server.url, "jobs", "wait", "missing"],
      capture.dependencies,
    );
    await server.close();
    expect(exitCode).toBe(5);
    expect(requests).toEqual(["/v1/organizations/org-1/jobs/missing/events?after=0&limit=100"]);
  });
});

const authenticatedCapture = async (apiUrl: string) => {
  const capture = await makeCliCapture();
  await writeCredentials(capture.dependencies.credentialsPath, {
    accessToken: "access",
    refreshToken: "refresh",
    accessTokenExpiresAt: "2026-07-11T14:00:00.000Z",
    apiUrl,
  });
  return capture;
};
