import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.ts";

describe("configuration", () => {
  it("uses safe media and retention defaults", () => {
    expect(loadConfig({})).toMatchObject({
      artifactTtlMs: 86_400_000,
      artifactAccessGrantTtlMs: 900_000,
      auth: {
        accessTokenTtlMs: 900_000,
        challengeTtlMs: 600_000,
        refreshTokenTtlMs: 2_592_000_000,
      },
      audioSilenceThresholdDb: -50,
      billing: {
        priceIds: { basic: "", scale: "", pro: "" },
      },
      databasePath: "./data/database.sqlite",
      email: { maxAttempts: 5, pollIntervalMs: 1_000 },
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe",
      host: "0.0.0.0",
      jobWorker: { concurrency: 3, maxAttempts: 2 },
      maxConcurrentMediaProcesses: 3,
      mediaRoot: "./data/media",
      planTtlMs: 3_600_000,
      port: 3_000,
      uploadTtlMs: 3_600_000,
      sourceTtlMs: 86_400_000,
    });
  });

  it("rejects unsafe concurrency and comparison limits", () => {
    expect(() => loadConfig({ MAX_CONCURRENT_MEDIA_PROCESSES: "0" })).toThrow();
    expect(() => loadConfig({ MAX_COMPARISON_SECONDS: "4" })).toThrow();
    expect(() => loadConfig({ JOB_HEARTBEAT_SECONDS: "30", JOB_LEASE_SECONDS: "20" })).toThrow();
  });

  it("keeps prepared-source retention within the documented one-hour minimum", () => {
    expect(() => loadConfig({ SOURCE_TTL_SECONDS: "3599" })).toThrow();
    expect(loadConfig({ SOURCE_TTL_SECONDS: "3600" }).sourceTtlSeconds).toBe(3_600);
  });
});
