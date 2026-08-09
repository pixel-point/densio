import { writeFile } from "node:fs/promises";
import { join } from "node:path";

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

const timestamp = "2026-07-11T12:00:00.000Z";

describe("compression command", () => {
  it("creates, streams, and waits while reserving stdout for one JSON result", async () => {
    const capture = await makeCliCapture();
    const sourcePath = join(capture.directory, "source video.mp4");
    await writeFile(sourcePath, "video-bytes");
    const requests: Array<{ readonly body: string; readonly idempotencyKey?: string }> = [];
    let statusRequests = 0;
    const server = await startCliServer(async (request, response) => {
      if (request.url === "/v1/compress") {
        requests.push({
          body: (await readRequestBody(request)).toString(),
          ...(request.headers["idempotency-key"] === undefined
            ? {}
            : { idempotencyKey: String(request.headers["idempotency-key"]) }),
        });
        sendEnvelope(response, jobCreated(server.url), 201);
        return;
      }
      if (request.url === "/upload/job-1") {
        requests.push({ body: (await readRequestBody(request)).toString() });
        sendEnvelope(response, {
          bytes: 11,
          jobId: "job-1",
          sha256: "b".repeat(64),
          state: "queued",
        });
        return;
      }
      statusRequests += 1;
      sendEnvelope(response, statusRequests === 1 ? activeJob() : succeededJob(server.url));
    });
    await writeCredentials(capture.dependencies.credentialsPath, {
      accessToken: "access",
      accessTokenExpiresAt: "2026-07-11T14:00:00.000Z",
      apiUrl: server.url,
      refreshToken: "refresh",
    });

    const exitCode = await runCli(
      [
        "--json",
        "--api-url",
        server.url,
        "compress",
        sourcePath,
        "--codec",
        "vp9",
        "--vp9-crf",
        "41",
        "--audio",
        "remove",
        "--width",
        "640",
        "--crop-aspect",
        "16:9",
        "--idempotency-key",
        "idem-1",
      ],
      capture.dependencies,
    );
    await server.close();

    expect(exitCode).toBe(0);
    expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
      options: {
        audio: "remove",
        codecs: ["vp9"],
        crf: { vp9: 41 },
        transform: {
          crop: { aspectRatio: "16:9", kind: "aspect-ratio" },
          scale: { width: 640 },
        },
      },
      source: { bytes: 11, filename: "source video.mp4" },
    });
    expect(requests[0]?.idempotencyKey).toBe("idem-1");
    expect(requests[1]?.body).toBe("video-bytes");
    expect(JSON.parse(capture.stdout()).data.state).toBe("succeeded");
    expect(capture.stdout().trim().split("\n")).toHaveLength(1);
    const stderrEvents = capture
      .stderr()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(stderrEvents[0]).toEqual({
      jobId: "job-1",
      resumeCommand: "densio jobs wait job-1",
      statusUrl: `${server.url}/v1/jobs/job-1`,
      type: "job-accepted",
    });
    expect(stderrEvents).toContainEqual({
      jobId: "job-1",
      progressPercent: 25,
      state: "processing",
      type: "progress",
    });
  });
});

describe("compression command acknowledgement", () => {
  it("displays the resumable job ID before polling in human mode", async () => {
    const capture = await makeCliCapture();
    const sourcePath = join(capture.directory, "source.mp4");
    await writeFile(sourcePath, "video-bytes");
    const acknowledgement =
      "Job job-1 uploaded and queued. Waiting for completion; " +
      "resume with densio jobs wait job-1.\n";
    let acknowledgedBeforePolling = false;
    const server = await startCliServer(async (request, response) => {
      if (request.url === "/v1/compress") {
        sendEnvelope(response, jobCreated(server.url), 201);
        return;
      }
      if (request.url === "/upload/job-1") {
        await readRequestBody(request);
        sendEnvelope(response, {
          bytes: 11,
          jobId: "job-1",
          sha256: "b".repeat(64),
          state: "queued",
        });
        return;
      }
      acknowledgedBeforePolling = capture.stderr() === acknowledgement;
      sendEnvelope(response, succeededJob(server.url));
    });
    await writeCredentials(capture.dependencies.credentialsPath, {
      accessToken: "access",
      accessTokenExpiresAt: "2026-07-11T14:00:00.000Z",
      apiUrl: server.url,
      refreshToken: "refresh",
    });

    const exitCode = await runCli(
      ["--api-url", server.url, "compress", sourcePath, "--codec", "vp9"],
      capture.dependencies,
    );
    await server.close();

    expect(exitCode).toBe(0);
    expect(acknowledgedBeforePolling).toBe(true);
    expect(capture.stderr()).toBe(acknowledgement);
  });
});

const jobCreated = (url: string) => ({
  jobId: "job-1",
  state: "awaiting-upload",
  statusUrl: `${url}/v1/jobs/job-1`,
  upload: {
    expiresAt: "2026-07-11T13:00:00.000Z",
    method: "PUT",
    url: `${url}/upload/job-1`,
  },
});

const jobBase = {
  createdAt: timestamp,
  id: "job-1",
  plan: "free",
  updatedAt: timestamp,
  workflow: "compress",
} as const;

const activeJob = () => ({ ...jobBase, progressPercent: 25, state: "processing" });

const succeededJob = (url: string) => ({
  ...jobBase,
  progressPercent: 100,
  result: {
    artifacts: [
      {
        bytes: 11,
        codec: "vp9",
        downloadUrl: `${url}/artifact/video.webm`,
        expiresAt: "2026-07-12T12:00:00.000Z",
        filename: "video.webm",
        id: "artifact-1",
        kind: "video",
        mediaType: "video/webm",
        sha256: "a".repeat(64),
      },
    ],
    commands: [
      {
        arguments: ["-i", "source"],
        completedAt: timestamp,
        displayCommand: "ffmpeg -i source",
        executable: "ffmpeg",
        exitCode: 0,
        startedAt: timestamp,
      },
    ],
    html: '<video><source src="video.webm"></video>',
    kind: "compress",
  },
  state: "succeeded",
});
