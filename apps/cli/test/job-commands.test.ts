import { afterEach, expect, it } from "vitest";
import { runCli } from "../src/cli.ts";
import { writeCredentials } from "../src/config.ts";
import {
  activeJob,
  canceledJob,
  successfulCompressionJob,
  timestamp,
} from "./canonical-fixtures.ts";
import {
  cleanupCliDirectories,
  makeCliCapture,
  sendEnvelope,
  startOrganizationCliServer,
} from "./cli-test-support.ts";

afterEach(cleanupCliDirectories);
const succeededJob = successfulCompressionJob([
  {
    organizationId: "org-1",
    id: "artifact-1",
    filename: "video.webm",
    kind: "video",
    mediaType: "video/webm",
    bytes: 7,
    sha256: "a".repeat(64),
    availability: "available",
    retainedUntil: "2026-07-12T12:00:00.000Z",
    authorizeUrl: "https://api.densio.test/v1/organizations/org-1/artifacts/artifact-1/authorize",
    deleteUrl: "https://api.densio.test/v1/organizations/org-1/artifacts/artifact-1",
  },
]);

it.each(["get", "cancel"])(
  "runs jobs %s with one authoritative status document",
  async (command) => {
    const requests: string[] = [];
    const server = await startOrganizationCliServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      sendEnvelope(response, command === "get" ? activeJob : canceledJob);
    });
    const capture = await authenticatedCapture(server.url);
    const exitCode = await runCli(
      ["--json", "--api-url", server.url, "jobs", command, "job-1"],
      capture.dependencies,
    );
    await server.close();
    expect(exitCode).toBe(0);
    expect(JSON.parse(capture.stdout()).data.id).toBe("job-1");
    expect(requests).toEqual([
      command === "get"
        ? "GET /v1/organizations/org-1/jobs/job-1"
        : "POST /v1/organizations/org-1/jobs/job-1/cancel",
    ]);
  },
);

it("deduplicates and orders events before returning one terminal status envelope", async () => {
  let eventRequests = 0;
  const requests: string[] = [];
  const server = await startOrganizationCliServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.url?.includes("/events")) {
      eventRequests += 1;
      sendEnvelope(
        response,
        eventRequests === 1
          ? { organizationId: "org-1", events: [event(8), event(7), event(8)], nextCursor: 8 }
          : { organizationId: "org-1", events: [event(8), event(9)], nextCursor: 9 },
      );
      return;
    }
    sendEnvelope(response, eventRequests === 1 ? activeJob : succeededJob);
  });
  const capture = await authenticatedCapture(server.url);
  const exitCode = await runCli(
    ["--json", "--api-url", server.url, "jobs", "wait", "job-1"],
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
  ).toEqual([7, 8, 9]);
  expect(requests).toEqual([
    "/v1/organizations/org-1/jobs/job-1/events?after=0&limit=100",
    "/v1/organizations/org-1/jobs/job-1",
    "/v1/organizations/org-1/jobs/job-1/events?after=8&limit=100",
    "/v1/organizations/org-1/jobs/job-1",
    "/v1/organizations/org-1/jobs/job-1/events?after=9&limit=100",
  ]);
});

it("polls active jobs at a bounded cadence and reports cancellation without retrying it", async () => {
  let statuses = 0;
  const sleeps: number[] = [];
  const server = await startOrganizationCliServer((request, response) => {
    if (request.url?.includes("/events")) {
      sendEnvelope(response, { organizationId: "org-1", events: [], nextCursor: 0 });
      return;
    }
    statuses += 1;
    sendEnvelope(response, statuses === 1 ? activeJob : canceledJob);
  });
  const capture = await authenticatedCapture(server.url);
  const exitCode = await runCli(["--json", "--api-url", server.url, "jobs", "wait", "job-1"], {
    ...capture.dependencies,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
  });
  await server.close();
  expect(exitCode).toBe(5);
  expect(statuses).toBe(2);
  expect(sleeps).toEqual([0, 2_000]);
  expect(JSON.parse(capture.stderr().trim().split("\n").at(-1) ?? "{}").code).toBe("JOB_CANCELED");
});

it("retries a transient event disconnect and confirms terminal state through status", async () => {
  let attempts = 0;
  const server = await startOrganizationCliServer((request, response) => {
    if (request.url?.includes("/events")) {
      attempts += 1;
      if (attempts === 1) {
        request.socket.destroy();
        return;
      }
      sendEnvelope(response, { organizationId: "org-1", events: [], nextCursor: 0 });
      return;
    }
    sendEnvelope(response, succeededJob);
  });
  const capture = await authenticatedCapture(server.url);
  const exitCode = await runCli(
    ["--json", "--api-url", server.url, "jobs", "wait", "job-1"],
    capture.dependencies,
  );
  await server.close();
  expect(exitCode).toBe(0);
  expect(attempts).toBe(3);
});

it("rejects another job's events before reading its status", async () => {
  const server = await startOrganizationCliServer((_request, response) =>
    sendEnvelope(response, {
      organizationId: "org-1",
      events: [{ ...event(1), jobId: "foreign" }],
      nextCursor: 1,
    }),
  );
  const capture = await authenticatedCapture(server.url);
  const exitCode = await runCli(
    ["--json", "--api-url", server.url, "jobs", "wait", "job-1"],
    capture.dependencies,
  );
  await server.close();
  expect(exitCode).toBe(5);
  expect(JSON.parse(capture.stderr().trim().split("\n").at(-1) ?? "{}").code).toBe(
    "CLI_INVALID_RESPONSE",
  );
});

it("times out without canceling remote work and supplies a resume command", async () => {
  const requests: string[] = [];
  const server = await startOrganizationCliServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    sendEnvelope(
      response,
      request.url?.includes("/events")
        ? { organizationId: "org-1", events: [], nextCursor: 0 }
        : activeJob,
    );
  });
  const capture = await authenticatedCapture(server.url);
  let now = capture.dependencies.now();
  const exitCode = await runCli(
    ["--json", "--api-url", server.url, "jobs", "wait", "job-1", "--timeout", "1"],
    {
      ...capture.dependencies,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    },
  );
  await server.close();
  expect(exitCode).toBe(6);
  expect(requests.every((request) => request.startsWith("GET "))).toBe(true);
  expect(JSON.parse(capture.stderr().trim().split("\n").at(-1) ?? "{}")).toMatchObject({
    code: "CLI_WAIT_TIMEOUT",
    suggestedAction: "Resume with densio --org org-1 jobs wait job-1.",
  });
});

it("interrupts locally without canceling the remote job", async () => {
  const capture = await authenticatedCapture("http://localhost:3000");
  const controller = new AbortController();
  controller.abort();
  const exitCode = await runCli(
    ["--json", "--api-url", "http://localhost:3000", "jobs", "wait", "job-1"],
    {
      ...capture.dependencies,
      signal: controller.signal,
    },
  );
  expect(exitCode).toBe(130);
  expect(JSON.parse(capture.stderr().trim().split("\n").at(-1) ?? "{}")).toMatchObject({
    code: "CLI_INTERRUPTED",
    jobId: "job-1",
  });
});

it.each([
  ["wait", "job-1", "--force"],
  ["wait", "job-1", "--timeout", "0"],
  ["decide-frame-rate", "job-1", "cap-30"],
])("rejects invalid and removed job arguments %j", async (...args) => {
  const capture = await makeCliCapture();
  expect(await runCli(["--json", "jobs", ...args], capture.dependencies)).toBe(2);
  expect(capture.stdout()).toBe("");
});

const event = (sequence: number) => ({
  sequence,
  jobId: "job-1",
  kind: "progress",
  state: "processing",
  occurredAt: timestamp,
  attempt: 1,
  progress: { ...activeJob.progress, revision: sequence },
});

it.each(["succeeded", "canceled", "failed"])(
  "drains all event pages before reporting %s",
  async (state) => {
    const server = await startOrganizationCliServer((request, response) => {
      if (request.url?.includes("/events")) {
        const after = Number(new URL(request.url, "http://localhost").searchParams.get("after"));
        const events = Array.from({ length: 201 }, (_, index) => event(index + 1))
          .filter((entry) => entry.sequence > after)
          .slice(0, 100);
        sendEnvelope(response, {
          organizationId: "org-1",
          events,
          nextCursor: events.at(-1)?.sequence ?? after,
        });
        return;
      }
      sendEnvelope(
        response,
        state === "succeeded"
          ? succeededJob
          : { ...canceledJob, state, progress: { ...canceledJob.progress, phase: state } },
      );
    });
    const capture = await authenticatedCapture(server.url);
    const exitCode = await runCli(
      ["--json", "--api-url", server.url, "jobs", "watch", "job-1"],
      capture.dependencies,
    );
    await server.close();
    expect(exitCode).toBe(state === "succeeded" ? 0 : 5);
    expect(
      capture
        .stderr()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.type === "job-event")
        .map((entry) => entry.sequence),
    ).toEqual(Array.from({ length: 201 }, (_, index) => index + 1));
  },
);
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
