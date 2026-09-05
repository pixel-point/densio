import { afterEach, expect, it } from "vitest";

import { runCli } from "../src/cli.ts";
import { writeCredentials } from "../src/config.ts";
import {
  cleanupCliDirectories,
  makeCliCapture,
  readRequestBody,
  sendEnvelope,
  startOrganizationCliServer,
} from "./cli-test-support.ts";

afterEach(cleanupCliDirectories);

it.each(["compress", "extract-images", "compare-quality", "hls"])(
  "submits %s through jobs without public planning",
  async (workflow) => {
    const capture = await makeCliCapture();
    const requests: Array<{
      url: string | undefined;
      body: unknown;
      key: string | string[] | undefined;
    }> = [];
    const server = await startOrganizationCliServer(async (request, response) => {
      requests.push({
        url: request.url,
        body: JSON.parse((await readRequestBody(request)).toString()),
        key: request.headers["idempotency-key"],
      });
      sendEnvelope(
        response,
        {
          organizationId: "org-1",
          jobId: "job-1",
          replayed: false,
          state: "queued",
          statusUrl: `${server.url}/v1/organizations/org-1/jobs/job-1`,
        },
        201,
      );
    });
    await authenticate(capture, server.url);
    const exit = await runCli(
      [
        "--json",
        "--api-url",
        server.url,
        "jobs",
        "create",
        "source-1",
        workflow,
        ...(workflow === "compare-quality" ? ["--matrix", "h265:28,30"] : []),
        "--max-credits",
        "2",
        "--client-reference",
        "launch",
        "--idempotency-key",
        "direct-key",
        "--no-wait",
      ],
      capture.dependencies,
    );
    await server.close();
    expect(exit).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "/v1/organizations/org-1/jobs",
      key: "direct-key",
      body: {
        sourceId: "source-1",
        workflow,
        constraints: { maxCredits: 2 },
        clientReference: "launch",
      },
    });
    expect(JSON.parse(capture.stdout()).data).toMatchObject({
      jobId: "job-1",
      resumeCommand: "densio --org org-1 jobs wait job-1",
    });
  },
);

it("creates an immutable plan with typed workflow options and planning guards", async () => {
  const capture = await makeCliCapture();
  let body = "";
  let idempotencyKey: string | undefined;
  const server = await startOrganizationCliServer(async (request, response) => {
    body = (await readRequestBody(request)).toString();
    idempotencyKey =
      request.headers["idempotency-key"] === undefined
        ? undefined
        : String(request.headers["idempotency-key"]);
    sendEnvelope(
      response,
      { organizationId: "org-1", plan: readyPlan(server.url), replayed: false },
      201,
    );
  });
  await authenticate(capture, server.url);

  const exitCode = await runCli(
    [
      "--json",
      "--api-url",
      server.url,
      "plans",
      "create",
      "source-1",
      "compress",
      "--codec",
      "vp9",
      "--vp9-crf",
      "41",
      "--frame-rate",
      "preserve",
      "--max-credits",
      "2",
      "--max-output-bytes",
      "4000000",
    ],
    capture.dependencies,
  );
  await server.close();

  expect(exitCode).toBe(0);
  expect(idempotencyKey).toBeUndefined();
  expect(JSON.parse(body)).toEqual({
    constraints: { maxCredits: 2, maxOutputBytes: 4_000_000 },
    options: { codecs: ["vp9"], crf: { vp9: 41 }, frameRate: { mode: "preserve" } },
    sourceId: "source-1",
    workflow: "compress",
  });
  expect(JSON.parse(capture.stdout()).data).toMatchObject({
    plan: { planId: "plan-1", quote: { credits: 1.25 }, state: "ready" },
    organizationId: "org-1",
    replayed: false,
  });
  expect(capture.stdout().trim().split("\n")).toHaveLength(1);
});

it("gets and resolves an immutable plan with an explicit frame-rate decision", async () => {
  const capture = await makeCliCapture();
  const requests: Array<{
    readonly body: string;
    readonly idempotencyKey?: string;
    readonly method: string | undefined;
    readonly url: string | undefined;
  }> = [];
  const server = await startOrganizationCliServer(async (request, response) => {
    requests.push({
      body: (await readRequestBody(request)).toString(),
      ...(request.headers["idempotency-key"] === undefined
        ? {}
        : { idempotencyKey: String(request.headers["idempotency-key"]) }),
      method: request.method,
      url: request.url,
    });
    if (request.method === "GET") {
      sendEnvelope(response, decisionPlan(server.url));
      return;
    }
    sendEnvelope(
      response,
      {
        plan: { ...readyPlan(server.url), supersedesPlanId: "plan/one" },
        organizationId: "org-1",
        replayed: false,
      },
      201,
    );
  });
  await authenticate(capture, server.url);

  const getExit = await runCli(
    ["--json", "--api-url", server.url, "plans", "get", "plan/one"],
    capture.dependencies,
  );
  const resolveExit = await runCli(
    [
      "--json",
      "--api-url",
      server.url,
      "plans",
      "resolve",
      "plan/one",
      "cap-30",
      "--idempotency-key",
      "plan/resolve-1",
    ],
    capture.dependencies,
  );
  await server.close();

  expect(getExit).toBe(0);
  expect(resolveExit).toBe(0);
  expect(requests).toEqual([
    { body: "", method: "GET", url: "/v1/organizations/org-1/execution-plans/plan%2Fone" },
    {
      body: JSON.stringify({ frameRate: { maximum: 30, mode: "cap" } }),
      idempotencyKey: "plan/resolve-1",
      method: "POST",
      url: "/v1/organizations/org-1/execution-plans/plan%2Fone/resolve",
    },
  ]);
});

it("guardedly executes without another upload and returns a resumable job", async () => {
  const capture = await makeCliCapture();
  let body = "";
  let idempotencyKey: string | undefined;
  let requestCount = 0;
  const server = await startOrganizationCliServer(async (request, response) => {
    requestCount += 1;
    body = (await readRequestBody(request)).toString();
    idempotencyKey = String(request.headers["idempotency-key"]);
    sendEnvelope(
      response,
      {
        jobId: "job-1",
        organizationId: "org-1",
        replayed: false,
        state: "queued",
        statusUrl: `${server.url}/v1/organizations/org-1/jobs/job-1`,
      },
      202,
    );
  });
  await authenticate(capture, server.url);

  const exitCode = await runCli(
    [
      "--json",
      "--api-url",
      server.url,
      "plans",
      "execute",
      "plan-1",
      "--idempotency-key",
      "plan/execute-1",
      "--max-credits",
      "1.25",
      "--max-output-bytes",
      "4000000",
      "--client-reference",
      "release/launch",
      "--no-wait",
    ],
    capture.dependencies,
  );
  await server.close();

  expect(exitCode).toBe(0);
  expect(requestCount).toBe(1);
  expect(idempotencyKey).toBe("plan/execute-1");
  expect(JSON.parse(body)).toEqual({
    clientReference: "release/launch",
    maxCredits: 1.25,
    maxOutputBytes: 4_000_000,
  });
  expect(JSON.parse(capture.stdout()).data).toEqual({
    jobId: "job-1",
    organizationId: "org-1",
    resumeCommand: "densio --org org-1 jobs wait job-1",
    statusUrl: `${server.url}/v1/organizations/org-1/jobs/job-1`,
  });
});

it("requires an execute idempotency key and exact credit precision before networking", async () => {
  const missingCapture = await makeCliCapture();
  const precisionCapture = await makeCliCapture();

  const missingKey = await runCli(
    ["--json", "plans", "execute", "plan-1", "--no-wait"],
    missingCapture.dependencies,
  );
  const impreciseCredits = await runCli(
    [
      "--json",
      "plans",
      "execute",
      "plan-1",
      "--idempotency-key",
      "execute-1",
      "--max-credits",
      "1.234",
      "--no-wait",
    ],
    precisionCapture.dependencies,
  );

  expect(missingKey).toBe(2);
  expect(impreciseCredits).toBe(2);
  expect(missingCapture.stdout()).toBe("");
  expect(JSON.parse(missingCapture.stderr())).toMatchObject({
    code: "CLI_USAGE_ERROR",
    detail: expect.stringMatching(/idempotency/i),
  });
  expect(precisionCapture.stdout()).toBe("");
  expect(JSON.parse(precisionCapture.stderr())).toMatchObject({
    code: "CLI_USAGE_ERROR",
    detail: expect.stringMatching(/invalid/i),
  });
});

const authenticate = async (capture: Awaited<ReturnType<typeof makeCliCapture>>, apiUrl: string) =>
  writeCredentials(capture.dependencies.credentialsPath, {
    accessToken: "access",
    accessTokenExpiresAt: "2026-07-11T14:00:00.000Z",
    apiUrl,
    refreshToken: "refresh",
  });

const timestamp = "2026-07-11T12:00:00.000Z";
const expiresAt = "2026-07-11T13:00:00.000Z";

const readyPlan = (apiUrl: string) => ({
  organizationId: "org-1",
  createdByUserId: "user-1",
  constraints: { maxCredits: 2, maxOutputBytes: 4_000_000 },
  createdAt: timestamp,
  availability: "available",
  execute: {
    expiresAt,
    method: "POST",
    url: `${apiUrl}/v1/organizations/org-1/execution-plans/plan-1/execute`,
  },
  expectedArtifacts: [
    { codec: "vp9", filename: "source-vp9.webm", kind: "video", mediaType: "video/webm" },
  ],
  expiresAt,
  intentDigest: "b".repeat(64),
  planId: "plan-1",
  quote: { availableCredits: 30, creditUnits: 125, credits: 1.25, kind: "exact" },
  requestedOptions: { codecs: ["vp9"], crf: { vp9: 41 }, frameRate: { mode: "preserve" } },
  resolvedOptions: {
    audio: "auto",
    codecs: ["vp9"],
    crf: { vp9: 41 },
    frameRate: { mode: "preserve" },
  },
  source: planSource,
  state: "ready",
  toolchain: { ffmpegVersion: "7.1.1", ffprobeVersion: "7.1.1" },
  warnings: [],
  workflow: "compress",
});

const decisionPlan = (apiUrl: string) => ({
  organizationId: "org-1",
  createdByUserId: "user-1",
  createdAt: timestamp,
  availability: "available",
  decision: {
    kind: "frame-rate",
    recommended: { maximum: 30, mode: "cap" },
    source: { denominator: 1, framesPerSecond: 60, numerator: 60 },
  },
  expiresAt,
  intentDigest: "c".repeat(64),
  planId: "plan/one",
  requestedOptions: { codecs: ["vp9"] },
  resolve: {
    expiresAt,
    method: "POST",
    url: `${apiUrl}/v1/organizations/org-1/execution-plans/plan%2Fone/resolve`,
  },
  source: planSource,
  state: "decision-required",
  toolchain: { ffmpegVersion: "7.1.1", ffprobeVersion: "7.1.1" },
  workflow: "compress",
});

const planSource = {
  declaredBytes: 11,
  filename: "source.mp4",
  inspection: {
    audioStreams: [],
    displayDimensions: { height: 1080, width: 1920 },
    durationSeconds: 30,
    encodedDimensions: { height: 1080, width: 1920 },
    frameRate: { denominator: 1, framesPerSecond: 30, numerator: 30 },
    primaryVideoStream: {
      codec: "h264",
      height: 1080,
      index: 0,
      type: "video",
      width: 1920,
    },
    rotationDegrees: 0,
    streams: [{ codec: "h264", index: 0, type: "video" }],
  },
  sha256: "a".repeat(64),
  sourceId: "source-1",
  verifiedBytes: 11,
};
