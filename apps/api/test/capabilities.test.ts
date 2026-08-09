import { CapabilitiesSchema } from "@densio/shared";
import { Schema } from "effect";
import { expect, it } from "vitest";

import { buildCapabilities } from "../src/capabilities.ts";
import { loadConfig } from "../src/config.ts";

const media = {
  encoders: ["libvpx-vp9", "libx265", "libsvtav1"],
  ffmpegVersion: "7.1-static",
  ffprobeVersion: "7.1-static",
} as const;

it("reports exact defaults and plan-specific upload limits through the shared schema", () => {
  const config = loadConfig({ MAX_UPLOAD_BYTES: "20000000000" });
  const free = Schema.decodeUnknownSync(CapabilitiesSchema)(
    buildCapabilities(config, media, "free"),
  );
  const basic = Schema.decodeUnknownSync(CapabilitiesSchema)(
    buildCapabilities(config, media, "basic"),
  );

  expect(free).toMatchObject({
    defaults: {
      comparisonDurationSeconds: 1,
      compressionCodecs: ["vp9", "h265"],
      extractionIntervalSeconds: 1,
    },
    limits: { maxUploadBytes: 1_000_000_000, maxVideoDurationSeconds: 1_800 },
    plan: "free",
  });
  expect(basic.limits.maxUploadBytes).toBe(10_000_000_000);
  expect(free.codecs.find(({ codec }) => codec === "av1")?.minimumPlan).toBe("free");
});

it("uses the configured comparison duration as the advertised option maximum", () => {
  const config = loadConfig({ MAX_COMPARISON_SECONDS: "1" });

  const capabilities = Schema.decodeUnknownSync(CapabilitiesSchema)(
    buildCapabilities(config, media, "free"),
  );

  expect(capabilities.limits.maxComparisonDurationSeconds).toBe(1);
  expect(capabilities.options.comparisonDurationSeconds).toEqual({
    default: 1,
    maximum: 1,
    minimum: 1,
  });
});
