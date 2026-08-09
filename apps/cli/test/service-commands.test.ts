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

const capabilities = {
  apiVersion: "v1",
  codecs: [
    {
      codec: "vp9",
      container: "webm",
      crfRange: { maximum: 63, minimum: 0 },
      defaultCrf: 42,
      minimumPlan: "free",
    },
  ],
  defaults: {
    audio: "auto",
    comparisonDurationSeconds: 1,
    comparisonPositionSeconds: 0,
    compressionCodecs: ["vp9", "h265"],
    extractionFormat: "jpeg",
    extractionIntervalSeconds: 1,
  },
  limits: {
    artifactRetentionSeconds: 86_400,
    maxComparisonCrfs: 8,
    maxComparisonDurationSeconds: 3,
    maxExtractionImages: 1_000,
    maxUploadBytes: 1_000_000,
    maxVideoDurationSeconds: 10,
  },
  options: {
    audioModes: ["auto", "keep", "remove"],
    comparisonCrfCount: { maximum: 8, minimum: 2 },
    comparisonDurationSeconds: { default: 1, maximum: 3, minimum: 1 },
    comparisonPositionKinds: ["seconds", "timecode", "frame"],
    cropKinds: ["aspect-ratio", "rectangle"],
    imageFormats: ["jpeg", "png", "webp"],
    scaleDimensions: ["width", "height"],
  },
  plan: "free",
  server: {
    ffmpegVersion: "7.1",
    ffprobeVersion: "7.1",
    maxConcurrentMediaProcesses: 3,
  },
  workflows: ["compress", "extract-images", "compare-quality"],
};

describe("service commands", () => {
  it("decodes capabilities and authenticated billing session links", async () => {
    const checkoutBodies: Array<unknown> = [];
    const server = await startCliServer(async (request, response) => {
      if (request.url === "/v1/capabilities") {
        sendEnvelope(response, capabilities);
        return;
      }
      if (request.url === "/v1/billing/checkout") {
        checkoutBodies.push(JSON.parse((await readRequestBody(request)).toString("utf8")));
      }
      sendEnvelope(
        response,
        {
          expiresAt: "2026-07-11T13:00:00.000Z",
          kind: request.url?.endsWith("portal") === true ? "portal" : "checkout",
          url: "https://billing.example/session",
        },
        201,
      );
    });
    const capabilityCapture = await makeCliCapture();

    expect(
      await runCli(
        ["--json", "--api-url", server.url, "capabilities"],
        capabilityCapture.dependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(capabilityCapture.stdout()).data.server.maxConcurrentMediaProcesses).toBe(3);
    for (const command of [["subscribe", "basic"], ["portal"]]) {
      const capture = await makeCliCapture();
      await writeCredentials(capture.dependencies.credentialsPath, {
        accessToken: "access",
        accessTokenExpiresAt: "2026-07-11T14:00:00.000Z",
        apiUrl: server.url,
        refreshToken: "refresh",
      });
      expect(
        await runCli(
          ["--json", "--api-url", server.url, "billing", ...command],
          capture.dependencies,
        ),
      ).toBe(0);
      expect(JSON.parse(capture.stdout()).data.url).toBe("https://billing.example/session");
    }
    expect(checkoutBodies).toEqual([{ plan: "basic" }]);
    await server.close();
  });
});
