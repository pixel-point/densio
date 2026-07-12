import { CapabilitiesSchema } from "@ffmpeg-api/shared";
import { Schema } from "effect";
import { expect, it } from "vitest";

import { buildCapabilities } from "../src/capabilities.ts";
import { loadConfig } from "../src/config.ts";

const media = {
  encoders: ["libvpx-vp9", "libx265", "libsvtav1"],
  ffmpegVersion: "7.1-static",
  ffprobeVersion: "7.1-static",
} as const;

it("reports exact defaults and plan-specific limits through the shared schema", () => {
  const config = loadConfig({ MAX_UPLOAD_BYTES: "123456" });
  const free = Schema.decodeUnknownSync(CapabilitiesSchema)(
    buildCapabilities(config, media, "free"),
  );
  const pro = Schema.decodeUnknownSync(CapabilitiesSchema)(buildCapabilities(config, media, "pro"));

  expect(free).toMatchObject({
    defaults: {
      comparisonDurationSeconds: 1,
      compressionCodecs: ["vp9", "h265"],
      extractionIntervalSeconds: 1,
    },
    limits: { maxUploadBytes: 123456, maxVideoDurationSeconds: 10 },
    plan: "free",
  });
  expect(pro.limits.maxVideoDurationSeconds).toBe(1_800);
  expect(pro.codecs.find(({ codec }) => codec === "av1")?.minimumPlan).toBe("pro");
});
