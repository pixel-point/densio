import { afterEach, describe, expect, it } from "vitest";

import { activeJob, successfulCompressionJob } from "./canonical-fixtures.ts";

import { runCli } from "../src/cli.ts";
import { writeCredentials } from "../src/config.ts";
import {
  cleanupCliDirectories,
  makeCliCapture,
  sendEnvelope,
  startOrganizationCliServer,
} from "./cli-test-support.ts";

afterEach(cleanupCliDirectories);

const progress = {
  attempt: 1,
  percent: 40,
  phase: "encoding",
  revision: 2,
} as const;

const summary = activeJob;
const succeededJob = successfulCompressionJob([
  {
    organizationId: "org-1",
    id: "artifact-1",
    filename: "video.webm",
    kind: "video",
    mediaType: "video/webm",
    bytes: 7,
    sha256: "a".repeat(64),
    retainedUntil: "2026-07-12T12:00:00.000Z",
    availability: "available",
    authorizeUrl: "https://api.densio.test/v1/organizations/org-1/artifacts/artifact-1/authorize",
    deleteUrl: "https://api.densio.test/v1/organizations/org-1/artifacts/artifact-1",
  },
]);

describe("billing recovery", () => {
  it("gets the authenticated billing status without opening a browser session", async () => {
    const requests: Array<{ readonly method?: string; readonly url?: string }> = [];
    const server = await startOrganizationCliServer((request, response) => {
      requests.push({
        ...(request.method === undefined ? {} : { method: request.method }),
        ...(request.url === undefined ? {} : { url: request.url }),
      });
      sendEnvelope(response, {
        organizationId: "org-1",
        billingEmail: "owner@example.com",
        credits: {
          available: 11.5,
          monthly: 30,
          reserved: 2,
          resetsAt: "2026-08-01T00:00:00.000Z",
          used: 16.5,
        },
        entitlementSource: "free",
        plan: "free",
      });
    });
    const capture = await authenticatedCapture(server.url);

    const exitCode = await runCli(
      ["--json", "--api-url", server.url, "billing", "status"],
      capture.dependencies,
    );
    await server.close();

    expect(exitCode).toBe(0);
    expect(requests).toEqual([{ method: "GET", url: "/v1/organizations/org-1/billing/status" }]);
    expect(JSON.parse(capture.stdout()).data).toMatchObject({
      organizationId: "org-1",
      billingEmail: "owner@example.com",
      credits: { available: 11.5, reserved: 2 },
      plan: "free",
    });
    expect(JSON.parse(capture.stderr())).toMatchObject({
      type: "organization-selected",
      organizationId: "org-1",
    });
  });

  it("summarizes credit and subscription timing in human output", async () => {
    const server = await startOrganizationCliServer((_request, response) => {
      sendEnvelope(response, {
        organizationId: "org-1",
        billingEmail: "owner@example.com",
        credits: {
          available: 11.5,
          monthly: 30,
          reserved: 2,
          resetsAt: "2026-08-01T00:00:00.000Z",
          used: 16.5,
        },
        entitlementSource: "stripe",
        plan: "basic",
        renewsAt: "2026-08-01T00:00:00.000Z",
        subscriptionStatus: "active",
      });
    });
    const capture = await authenticatedCapture(server.url);

    const exitCode = await runCli(
      ["--api-url", server.url, "billing", "status"],
      capture.dependencies,
    );
    await server.close();

    expect(exitCode).toBe(0);
    expect(capture.stdout()).toContain("basic plan");
    expect(capture.stdout()).toContain("11.5 available, 2 reserved, 16.5 used of 30 monthly");
    expect(capture.stdout()).toContain("resets 2026-08-01T00:00:00.000Z");
    expect(capture.stdout()).toContain("subscription active");
    expect(capture.stdout()).toContain("renews 2026-08-01T00:00:00.000Z");
  });
});

describe("job discovery", () => {
  it("lists jobs with typed filters and preserves the opaque cursor", async () => {
    let query: URLSearchParams | undefined;
    const server = await startOrganizationCliServer((request, response) => {
      query = new URL(request.url ?? "", server.url).searchParams;
      sendEnvelope(response, {
        organizationId: "org-1",
        jobs: [summary],
        nextCursor: "opaque+/cursor==",
      });
    });
    const capture = await authenticatedCapture(server.url);

    const exitCode = await runCli(
      [
        "--json",
        "--api-url",
        server.url,
        "jobs",
        "list",
        "--state",
        "processing",
        "--workflow",
        "compress",
        "--since",
        "2026-07-01T00:00:00.000Z",
        "--client-reference",
        "site hero",
        "--idempotency-key",
        "request-1",
        "--limit",
        "25",
        "--cursor",
        "opaque+/cursor==",
      ],
      capture.dependencies,
    );
    await server.close();

    expect(exitCode).toBe(0);
    expect(Object.fromEntries(query ?? [])).toEqual({
      clientReference: "site hero",
      cursor: "opaque+/cursor==",
      idempotencyKey: "request-1",
      limit: "25",
      since: "2026-07-01T00:00:00.000Z",
      state: "processing",
      workflow: "compress",
    });
    expect(JSON.parse(capture.stdout()).data.nextCursor).toBe("opaque+/cursor==");
  });

  it("looks up a job using exactly one recovery selector", async () => {
    let requestedUrl = "";
    const server = await startOrganizationCliServer((request, response) => {
      requestedUrl = request.url ?? "";
      sendEnvelope(response, succeededJob);
    });
    const capture = await authenticatedCapture(server.url);

    const exitCode = await runCli(
      ["--json", "--api-url", server.url, "jobs", "lookup", "--client-reference", "site hero"],
      capture.dependencies,
    );
    await server.close();

    expect(exitCode).toBe(0);
    expect(requestedUrl).toBe("/v1/organizations/org-1/jobs/lookup?clientReference=site+hero");
    expect(JSON.parse(capture.stdout()).data.id).toBe("job-1");
  });

  it("rejects ambiguous job lookup selectors before authentication", async () => {
    const capture = await makeCliCapture();

    const exitCode = await runCli(
      [
        "--json",
        "jobs",
        "lookup",
        "--client-reference",
        "site-hero",
        "--idempotency-key",
        "request-1",
      ],
      capture.dependencies,
    );

    expect(exitCode).toBe(2);
    expect(JSON.parse(capture.stderr().trim().split("\n").at(-1) ?? "{}").detail).toContain(
      "exactly one",
    );
  });
});

describe("job events", () => {
  it("gets one finite ordered event page", async () => {
    let requestedUrl = "";
    const server = await startOrganizationCliServer((request, response) => {
      requestedUrl = request.url ?? "";
      sendEnvelope(response, {
        organizationId: "org-1",
        events: [event(8, "progress", "processing", progress)],
        nextCursor: 8,
      });
    });
    const capture = await authenticatedCapture(server.url);

    const exitCode = await runCli(
      [
        "--json",
        "--api-url",
        server.url,
        "jobs",
        "events",
        "job-1",
        "--after",
        "7",
        "--limit",
        "20",
      ],
      capture.dependencies,
    );
    await server.close();

    expect(exitCode).toBe(0);
    expect(requestedUrl).toBe("/v1/organizations/org-1/jobs/job-1/events?after=7&limit=20");
    expect(JSON.parse(capture.stdout()).data.events).toHaveLength(1);
    expect(JSON.parse(capture.stderr())).toMatchObject({
      type: "organization-selected",
      organizationId: "org-1",
    });
  });
});

describe("job event streaming", () => {
  it("watches finite pages, deduplicates by sequence, and emits one final stdout envelope", async () => {
    let eventRequests = 0;
    const server = await startOrganizationCliServer((request, response) => {
      if (request.url?.startsWith("/v1/organizations/org-1/jobs/job-1/events") === true) {
        eventRequests += 1;
        sendEnvelope(
          response,
          eventRequests === 1
            ? {
                organizationId: "org-1",
                events: [
                  event(7, "state-changed", "processing", progress),
                  event(8, "progress", "processing", { ...progress, revision: 3 }),
                  event(8, "progress", "processing", { ...progress, revision: 3 }),
                  {
                    ...event(9, "state-changed", "processing", {
                      ...progress,
                      percent: 5,
                      phase: "publishing",
                      revision: 4,
                    }),
                    kind: "state-changed",
                    state: "publishing",
                  },
                ],
                nextCursor: 9,
              }
            : {
                organizationId: "org-1",
                events: [
                  event(8, "progress", "processing", { ...progress, revision: 3 }),
                  event(10, "terminal", "succeeded", {
                    ...progress,
                    percent: 100,
                    phase: "complete",
                    revision: 4,
                  }),
                ],
                nextCursor: 10,
              },
        );
        return;
      }
      sendEnvelope(response, eventRequests === 1 ? summary : succeededJob);
    });
    const capture = await authenticatedCapture(server.url);

    const exitCode = await runCli(
      ["--json", "--api-url", server.url, "jobs", "watch", "job-1"],
      capture.dependencies,
    );
    await server.close();

    expect(exitCode).toBe(0);
    expect(capture.stdout().trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(capture.stdout()).data.state).toBe("succeeded");
    expect(
      capture
        .stderr()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((event) => event.type === "job-event")
        .map((event) => event.sequence),
    ).toEqual([7, 8, 9, 10]);
    expect(eventRequests).toBe(3);
  });
});

describe("job event recovery", () => {
  it("uses status as authority when an event page is empty", async () => {
    const controller = new AbortController();
    const requests: Array<string | undefined> = [];
    const server = await startOrganizationCliServer((request, response) => {
      requests.push(request.url);
      sendEnvelope(
        response,
        request.url?.includes("/events") === true
          ? { organizationId: "org-1", events: [], nextCursor: 0 }
          : succeededJob,
      );
    });
    const capture = await authenticatedCapture(server.url);

    const exitCode = await runCli(["--json", "--api-url", server.url, "jobs", "watch", "job-1"], {
      ...capture.dependencies,
      signal: controller.signal,
      sleep: async (milliseconds) => {
        if (milliseconds > 0) controller.abort();
      },
    });
    await server.close();

    expect(exitCode).toBe(0);
    expect(requests).toEqual([
      "/v1/organizations/org-1/jobs/job-1/events?after=0&limit=100",
      "/v1/organizations/org-1/jobs/job-1",
      "/v1/organizations/org-1/jobs/job-1/events?after=0&limit=100",
    ]);
    expect(JSON.parse(capture.stdout()).data.state).toBe("succeeded");
  });

  it("keeps the server job resumable when event watching is interrupted", async () => {
    const capture = await authenticatedCapture("http://localhost:3000");
    const controller = new AbortController();
    controller.abort();

    const exitCode = await runCli(
      ["--json", "--api-url", "http://localhost:3000", "jobs", "watch", "job-1"],
      { ...capture.dependencies, signal: controller.signal },
    );

    expect(exitCode).toBe(130);
    expect(JSON.parse(capture.stderr().trim().split("\n").at(-1) ?? "{}")).toMatchObject({
      code: "CLI_INTERRUPTED",
      suggestedAction: "Resume with densio --org ORG_ID jobs watch job-1.",
    });
  });
});

const event = (
  sequence: number,
  kind: "state-changed" | "progress" | "terminal",
  state: "processing" | "succeeded",
  eventProgress: {
    readonly attempt: number;
    readonly percent: number;
    readonly phase: "publishing" | "complete" | "encoding";
    readonly revision: number;
  },
) => ({
  attempt: eventProgress.attempt,
  jobId: "job-1",
  kind,
  occurredAt: "2026-07-11T11:01:00.000Z",
  progress: eventProgress,
  sequence,
  state,
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
