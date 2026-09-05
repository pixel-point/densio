import { CapabilitiesSchema, PublicCapabilitiesSchema } from "@densio/shared";
import { Schema } from "effect";
import { expect, it } from "vitest";

import { buildCapabilities, buildPublicCapabilities } from "../src/capabilities.ts";
import { loadConfig } from "../src/config.ts";

const media = {
  encoders: ["libvpx-vp9", "libx265", "libsvtav1"],
  ffmpegVersion: "7.1-static",
  ffprobeVersion: "7.1-static",
} as const;
const organization = {
  scope: "organization",
  organizationId: "org-1",
  organizationName: "Team",
  role: "member",
  actions: ["media-read", "media-write"],
} as const;

it("reports exact defaults and plan-specific upload limits through the shared schema", () => {
  const config = loadConfig({ MAX_UPLOAD_BYTES: "20000000000" });
  const free = Schema.decodeUnknownSync(CapabilitiesSchema)({
    ...buildCapabilities(config, media, "free"),
    ...organization,
  });
  const basic = Schema.decodeUnknownSync(CapabilitiesSchema)({
    ...buildCapabilities(config, media, "basic"),
    ...organization,
  });

  expect(free).toMatchObject({
    controlPlane: {
      artifactAccessGrantTtlSeconds: 900,
      executionPlans: true,
      jobEvents: true,
      planTtlSeconds: 3_600,
      preparedSources: true,
      sourceRetentionSeconds: 86_400,
      stableArtifacts: true,
    },
    defaults: {
      bitDepth: 8,
      comparisonDurationSeconds: 1,
      compressionCodecs: ["vp9", "h265"],
      extractionIntervalSeconds: 1,
    },
    options: {
      bitDepths: [8, 10],
      comparisonMetrics: ["ssim", "psnr"],
      comparisonSampleCount: { default: 3, maximum: 5, minimum: 1 },
      comparisonVariantCount: { maximum: 8, minimum: 2 },
    },
    limits: { maxUploadBytes: 1_000_000_000, maxVideoDurationSeconds: 1_800 },
    plan: "free",
  });
  expect(basic.limits.maxUploadBytes).toBe(10_000_000_000);
  expect(basic.limits.maxVideoDurationSeconds).toBe(10_800);
  expect(free.codecs.find(({ codec }) => codec === "av1")?.minimumPlan).toBe("basic");
});

it("uses the configured comparison duration as the advertised option maximum", () => {
  const config = loadConfig({ MAX_COMPARISON_SECONDS: "1" });

  const capabilities = Schema.decodeUnknownSync(CapabilitiesSchema)({
    ...buildCapabilities(config, media, "free"),
    ...organization,
  });

  expect(capabilities.limits.maxComparisonDurationSeconds).toBe(1);
  expect(capabilities.options.comparisonDurationSeconds).toEqual({
    default: 1,
    maximum: 1,
    minimum: 1,
  });
});

it("publishes a common catalog without pretending to know an anonymous caller's plan", () => {
  const capabilities = Schema.decodeUnknownSync(PublicCapabilitiesSchema)(
    buildPublicCapabilities(loadConfig({}), media),
  );
  expect(capabilities.scope).toBe("public");
  expect(capabilities).not.toHaveProperty("plan");
  expect(capabilities).not.toHaveProperty("organizationId");
  expect(
    capabilities.plans.map(({ monthlyCredits }) => monthlyCredits).toSorted((a, b) => a - b),
  ).toEqual([30, 750, 5000, 7500]);
});

it("advertises storage availability and exact managed plan capacity", () => {
  const capabilities = buildCapabilities(loadConfig({}), media, "basic");
  expect(capabilities).toMatchObject({
    storage: {
      publicByDefault: true,
      customerStorage: true,
      customerStorageConfigured: false,
      managedStorageConfigured: false,
    },
    limits: { includedStorageBytes: 25_000_000_000 },
  });
  expect(
    buildPublicCapabilities(loadConfig({}), media).plans.map(({ limits }) => limits),
  ).toMatchObject([
    { includedStorageBytes: 0 },
    { includedStorageBytes: 25_000_000_000 },
    { includedStorageBytes: 100_000_000_000 },
    { includedStorageBytes: 500_000_000_000 },
  ]);
});
