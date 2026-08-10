import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.ts";
import { writeCredentials } from "../src/config.ts";
import {
  cleanupCliDirectories,
  makeCliCapture,
  readRequestBody,
  sendEnvelope,
  startCliServer,
} from "./cli-test-support.ts";

afterEach(cleanupCliDirectories);

const activeJob = {
  createdAt: "2026-07-11T12:00:00.000Z",
  id: "job-1",
  plan: "free",
  progressPercent: 40,
  state: "processing",
  updatedAt: "2026-07-11T12:00:00.000Z",
  workflow: "compress",
} as const;

const canceledJob = {
  ...activeJob,
  problem: {
    code: "JOB_CANCELED",
    correlationId: "server-correlation",
    detail: "Canceled for the test.",
    jobId: "job-1",
    retryable: false,
    schemaVersion: 1,
    status: 409,
    suggestedAction: "Create another job.",
    title: "Canceled",
    type: "about:blank",
  },
  state: "canceled",
} as const;

const awaitingDecisionJob = {
  ...activeJob,
  decision: {
    kind: "frame-rate",
    recommended: { maximum: 30, mode: "cap" },
    source: { denominator: 1001, framesPerSecond: 59.94005994005994, numerator: 60_000 },
    submitUrl: "http://localhost:3000/v1/jobs/job-1/frame-rate-decision",
  },
  progressPercent: 5,
  state: "awaiting-decision",
} as const;

describe("frame-rate job commands", () => {
  it("returns an actionable frame-rate decision instead of polling forever", async () => {
    const server = await startCliServer((_request, response) => {
      sendEnvelope(response, {
        ...awaitingDecisionJob,
        decision: {
          ...awaitingDecisionJob.decision,
          submitUrl: `${server.url}/v1/jobs/job-1/frame-rate-decision`,
        },
      });
    });
    const capture = await authenticatedCapture(server.url);
    const sleepDurations: Array<number> = [];

    const exitCode = await runCli(["--json", "--api-url", server.url, "jobs", "wait", "job-1"], {
      ...capture.dependencies,
      sleep: async (milliseconds) => {
        sleepDurations.push(milliseconds);
      },
    });
    await server.close();

    expect(exitCode).toBe(0);
    expect(JSON.parse(capture.stdout()).data).toMatchObject({ state: "awaiting-decision" });
    expect(sleepDurations).toEqual([0]);
  });

  it("submits a frame-rate decision and resumes waiting", async () => {
    const requests: Array<{
      readonly body: string;
      readonly method?: string;
      readonly url?: string;
    }> = [];
    const server = await startCliServer(async (request, response) => {
      if (request.url?.endsWith("frame-rate-decision") === true) {
        requests.push({
          body: (await readRequestBody(request)).toString(),
          method: request.method ?? "GET",
          url: request.url,
        });
        sendEnvelope(response, { ...activeJob, progressPercent: 5, state: "queued" });
        return;
      }
      sendEnvelope(response, canceledJob);
    });
    const capture = await authenticatedCapture(server.url);

    const exitCode = await runCli(
      ["--json", "--api-url", server.url, "jobs", "decide-frame-rate", "job-1", "cap-30"],
      capture.dependencies,
    );
    await server.close();

    expect(exitCode).toBe(5);
    expect(requests).toEqual([
      {
        body: '{"frameRate":{"maximum":30,"mode":"cap"}}',
        method: "POST",
        url: "/v1/jobs/job-1/frame-rate-decision",
      },
    ]);
  });

  it("prints both decision commands in human mode", async () => {
    const server = await startCliServer((_request, response) => {
      sendEnvelope(response, {
        ...awaitingDecisionJob,
        decision: {
          ...awaitingDecisionJob.decision,
          submitUrl: `${server.url}/v1/jobs/job-1/frame-rate-decision`,
        },
      });
    });
    const capture = await authenticatedCapture(server.url);

    const exitCode = await runCli(
      ["--api-url", server.url, "jobs", "get", "job-1"],
      capture.dependencies,
    );
    await server.close();

    expect(exitCode).toBe(0);
    expect(capture.stdout()).toContain("59.94 fps");
    expect(capture.stdout()).toContain("densio jobs decide-frame-rate job-1 cap-30");
    expect(capture.stdout()).toContain("densio jobs decide-frame-rate job-1 preserve");
  });
});

describe("job commands", () => {
  it("gets and cancels a durable job by ID", async () => {
    const methods: Array<string | undefined> = [];
    const server = await startCliServer((request, response) => {
      methods.push(request.method);
      sendEnvelope(
        response,
        request.url?.endsWith("cancel") === true
          ? { ...activeJob, progressPercent: 40, state: "canceled" }
          : activeJob,
      );
    });
    for (const command of ["get", "cancel"]) {
      const capture = await authenticatedCapture(server.url);
      expect(
        await runCli(
          ["--json", "--api-url", server.url, "jobs", command, "job-1"],
          capture.dependencies,
        ),
      ).toBe(0);
      expect(JSON.parse(capture.stdout()).data.id).toBe("job-1");
    }
    await server.close();

    expect(methods).toEqual(["GET", "POST"]);
  });

  it("leaves a server job running and prints a resume action on interruption", async () => {
    const capture = await authenticatedCapture();
    const controller = new AbortController();
    controller.abort();

    const exitCode = await runCli(
      ["--json", "--api-url", "http://localhost:3000", "jobs", "wait", "job-1", "--timeout", "30"],
      {
        ...capture.dependencies,
        signal: controller.signal,
      },
    );

    expect(exitCode).toBe(130);
    expect(JSON.parse(capture.stderr())).toMatchObject({
      code: "CLI_INTERRUPTED",
      suggestedAction: "Resume with densio jobs wait job-1.",
    });
  });

  it("waits ten seconds before polling an active job again", async () => {
    let requests = 0;
    const server = await startCliServer((_request, response) => {
      requests += 1;
      sendEnvelope(response, requests === 1 ? activeJob : canceledJob);
    });
    const capture = await authenticatedCapture(server.url);
    const sleepDurations: Array<number> = [];

    const exitCode = await runCli(["--json", "--api-url", server.url, "jobs", "wait", "job-1"], {
      ...capture.dependencies,
      sleep: async (milliseconds) => {
        sleepDurations.push(milliseconds);
      },
    });
    await server.close();

    expect(exitCode).toBe(5);
    expect(requests).toBe(2);
    expect(sleepDurations).toEqual([0, 10_000]);
  });

  it("retries a transient polling disconnect before handling terminal state", async () => {
    let requests = 0;
    const server = await startCliServer((request, response) => {
      requests += 1;
      if (requests === 1) {
        request.socket.destroy();
        return;
      }
      sendEnvelope(response, canceledJob);
    });
    const capture = await authenticatedCapture(server.url);

    const exitCode = await runCli(
      ["--json", "--api-url", server.url, "jobs", "wait", "job-1"],
      capture.dependencies,
    );
    await server.close();

    expect(exitCode).toBe(5);
    expect(requests).toBe(2);
    expect(JSON.parse(capture.stderr().trim().split("\n").at(-1) ?? "")).toMatchObject({
      code: "JOB_CANCELED",
    });
  });
});

const authenticatedCapture = async (apiUrl = "http://localhost:3000") => {
  const capture = await makeCliCapture();
  await writeCredentials(capture.dependencies.credentialsPath, {
    accessToken: "access",
    accessTokenExpiresAt: "2026-07-11T14:00:00.000Z",
    apiUrl,
    refreshToken: "refresh",
  });
  return capture;
};
