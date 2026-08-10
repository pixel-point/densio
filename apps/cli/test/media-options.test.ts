import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.ts";
import { writeCredentials } from "../src/config.ts";
import { parseCompressionCommand } from "../src/media-options.ts";
import {
  cleanupCliDirectories,
  makeCliCapture,
  readRequestBody,
  sendEnvelope,
  startCliServer,
} from "./cli-test-support.ts";

afterEach(cleanupCliDirectories);

describe("compression frame-rate options", () => {
  it("parses explicit compression frame-rate policies", () => {
    expect(
      parseCompressionCommand(["video.mp4", "--frame-rate", "preserve"]).options,
    ).toMatchObject({
      frameRate: { mode: "preserve" },
    });
    expect(parseCompressionCommand(["video.mp4", "--frame-rate", "cap-30"]).options).toMatchObject({
      frameRate: { maximum: 30, mode: "cap" },
    });
    expect(() => parseCompressionCommand(["video.mp4", "--frame-rate", "60"])).toThrow(
      /frame-rate/i,
    );
  });
});

describe("media option commands", () => {
  it("rejects a non-positive client wait timeout before making requests", () => {
    expect(() => parseCompressionCommand(["video.mp4", "--timeout", "0"])).toThrow(/positive/i);
  });

  it.each([
    {
      arguments: ["extract-images", "--interval", "0.5", "--format", "webp", "--height", "360"],
      endpoint: "/v1/extract-images",
      options: { format: "webp", intervalSeconds: 0.5, transform: { scale: { height: 360 } } },
    },
    {
      arguments: [
        "compare-quality",
        "--codec",
        "h265",
        "--crf",
        "24,30",
        "--duration",
        "3",
        "--at",
        "01:02.500",
        "--crop-rect",
        "640:360:10:20",
      ],
      endpoint: "/v1/compare-quality",
      options: {
        codec: "h265",
        crfs: [24, 30],
        durationSeconds: 3,
        position: { kind: "timecode", timecode: "01:02.500" },
        transform: {
          crop: { height: 360, kind: "rectangle", width: 640, x: 10, y: 20 },
        },
      },
    },
  ])("sends typed $endpoint options and returns a resume command", async (scenario) => {
    const capture = await makeCliCapture();
    const sourcePath = join(capture.directory, "source.mp4");
    await writeFile(sourcePath, "video");
    let creationBody = "";
    const server = await startCliServer(async (request, response) => {
      if (request.url === scenario.endpoint) {
        creationBody = (await readRequestBody(request)).toString();
        sendEnvelope(response, {
          jobId: "job-resume",
          state: "awaiting-upload",
          statusUrl: `${server.url}/v1/jobs/job-resume`,
          upload: {
            expiresAt: "2026-07-11T13:00:00.000Z",
            method: "PUT",
            url: `${server.url}/upload/job-resume`,
          },
        });
        return;
      }
      const uploaded = await readRequestBody(request);
      sendEnvelope(response, {
        bytes: uploaded.length,
        jobId: "job-resume",
        sha256: "b".repeat(64),
        state: "queued",
      });
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
        ...scenario.arguments.slice(0, 1),
        sourcePath,
        ...scenario.arguments.slice(1),
        "--no-wait",
      ],
      capture.dependencies,
    );
    await server.close();

    expect(exitCode).toBe(0);
    expect(JSON.parse(creationBody)).toEqual({
      options: scenario.options,
      source: { bytes: 5, filename: "source.mp4" },
    });
    expect(JSON.parse(capture.stdout()).data).toMatchObject({
      jobId: "job-resume",
      resumeCommand: "densio jobs wait job-resume",
    });
  });
});
