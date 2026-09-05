import { writeFile } from "node:fs/promises";
import { join } from "node:path";

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

const createdAt = "2026-07-11T12:00:00.000Z";
const expiresAt = "2026-07-12T12:00:00.000Z";

it("creates, acknowledges, uploads, and returns one trusted source inspection", async () => {
  const capture = await makeCliCapture();
  const inputPath = join(capture.directory, "source video.mp4");
  await writeFile(inputPath, "video-bytes");
  const requests: Array<{ readonly body: string; readonly idempotencyKey?: string }> = [];
  const server = await startOrganizationCliServer(async (request, response) => {
    requests.push({
      body: (await readRequestBody(request)).toString(),
      ...(request.headers["idempotency-key"] === undefined
        ? {}
        : { idempotencyKey: String(request.headers["idempotency-key"]) }),
    });
    if (request.method === "POST") {
      sendEnvelope(
        response,
        {
          organizationId: "org-1",
          replayed: false,
          source: awaitingSource(server.url, "source video.mp4", 11),
        },
        201,
      );
      return;
    }
    sendEnvelope(response, readySource("source video.mp4", 11));
  });
  await authenticate(capture, server.url);

  const exitCode = await runCli(
    [
      "--json",
      "--api-url",
      server.url,
      "inspect",
      inputPath,
      "--idempotency-key",
      "source/create-1",
    ],
    capture.dependencies,
  );
  await server.close();

  expect(exitCode).toBe(0);
  expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
    bytes: 11,
    filename: "source video.mp4",
  });
  expect(requests[0]?.idempotencyKey).toBe("source/create-1");
  expect(requests[1]?.body).toBe("video-bytes");
  expect(JSON.parse(capture.stdout()).data).toMatchObject({
    sourceId: "source-1",
    state: "ready",
    inspection: { durationSeconds: 30 },
  });
  expect(capture.stdout().trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(capture.stderr().trim().split("\n").at(-1) ?? "{}")).toEqual({
    organizationId: "org-1",
    resumeCommand: "densio --org org-1 sources get source-1",
    sourceId: "source-1",
    statusUrl: `${server.url}/v1/organizations/org-1/sources/source-1`,
    type: "source-created",
  });
});

it("returns a replayed ready source without uploading the local bytes again", async () => {
  const capture = await makeCliCapture();
  const inputPath = join(capture.directory, "source.mp4");
  await writeFile(inputPath, "video-bytes");
  let requestCount = 0;
  const server = await startOrganizationCliServer((_request, response) => {
    requestCount += 1;
    sendEnvelope(response, {
      organizationId: "org-1",
      replayed: true,
      source: readySource("source.mp4", 11),
    });
  });
  await authenticate(capture, server.url);

  const exitCode = await runCli(
    ["--json", "--api-url", server.url, "inspect", inputPath, "--idempotency-key", "retry"],
    capture.dependencies,
  );
  await server.close();

  expect(exitCode).toBe(0);
  expect(requestCount).toBe(1);
  expect(JSON.parse(capture.stdout()).data.state).toBe("ready");
});

it("gets and deletes an owned prepared source", async () => {
  const capture = await makeCliCapture();
  const requests: Array<{
    readonly method: string | undefined;
    readonly url: string | undefined;
  }> = [];
  const server = await startOrganizationCliServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    if (request.method === "DELETE") {
      sendEnvelope(response, {
        organizationId: "org-1",
        deletedAt: createdAt,
        sourceId: "source/one",
        state: "deleted",
      });
      return;
    }
    sendEnvelope(response, readySource("source.mp4", 11, "source/one"));
  });
  await authenticate(capture, server.url);

  const getExit = await runCli(
    ["--json", "--api-url", server.url, "sources", "get", "source/one"],
    capture.dependencies,
  );
  const deleteExit = await runCli(
    ["--json", "--api-url", server.url, "sources", "delete", "source/one"],
    capture.dependencies,
  );
  await server.close();

  expect(getExit).toBe(0);
  expect(deleteExit).toBe(0);
  expect(requests).toEqual([
    { method: "GET", url: "/v1/organizations/org-1/sources/source%2Fone" },
    { method: "DELETE", url: "/v1/organizations/org-1/sources/source%2Fone" },
  ]);
  expect(capture.stdout().trim().split("\n")).toHaveLength(2);
});

const authenticate = async (capture: Awaited<ReturnType<typeof makeCliCapture>>, apiUrl: string) =>
  writeCredentials(capture.dependencies.credentialsPath, {
    accessToken: "access",
    accessTokenExpiresAt: "2026-07-11T14:00:00.000Z",
    apiUrl,
    refreshToken: "refresh",
  });

const sourceBase = (filename: string, declaredBytes: number, sourceId = "source-1") => ({
  organizationId: "org-1",
  createdByUserId: "user-1",
  createdAt,
  declaredBytes,
  expiresAt,
  filename,
  sourceId,
  updatedAt: createdAt,
});

const awaitingSource = (apiUrl: string, filename: string, declaredBytes: number) => ({
  ...sourceBase(filename, declaredBytes),
  state: "awaiting-upload",
  upload: {
    expiresAt,
    method: "PUT",
    url: `${apiUrl}/v1/organizations/org-1/sources/source-1/upload`,
  },
});

const readySource = (filename: string, declaredBytes: number, sourceId = "source-1") => ({
  ...sourceBase(filename, declaredBytes, sourceId),
  inspection: {
    audioStreams: [{ channels: 2, codec: "aac", index: 1, type: "audio" }],
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
    streams: [
      { codec: "h264", index: 0, type: "video" },
      { codec: "aac", index: 1, type: "audio" },
    ],
  },
  sha256: "a".repeat(64),
  state: "ready",
  verifiedBytes: declaredBytes,
});
