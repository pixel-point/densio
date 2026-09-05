import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { CapabilitiesSchema, PublicCapabilitiesSchema, PlanLimitsSchema } from "../src/index.ts";

const limits = {
  maxVideoDurationSeconds: 10,
  maxUploadBytes: 100_000_000,
  maxExtractionImages: 300,
  maxComparisonVariants: 8,
  maxComparisonDurationSeconds: 3,
  artifactRetentionSeconds: 86_400,
};

const options = {
  audioModes: ["auto", "keep", "remove"],
  imageFormats: ["jpeg", "png", "webp"],
  cropKinds: ["aspect-ratio", "rectangle"],
  scaleDimensions: ["width", "height"],
  comparisonPositionKinds: ["seconds", "timecode", "frame"],
  comparisonVariantCount: { minimum: 2, maximum: 8 },
  comparisonSampleCount: { minimum: 1, maximum: 5, default: 3 },
  comparisonMetrics: ["ssim", "psnr"],
  comparisonDurationSeconds: { minimum: 1, maximum: 3, default: 1 },
};

describe("plan limits", () => {
  it("accepts finite positive resource limits", () => {
    expect(Schema.decodeUnknownSync(PlanLimitsSchema)(limits)).toEqual(limits);
  });

  it("rejects a non-positive duration limit", () => {
    expect(() =>
      Schema.decodeUnknownSync(PlanLimitsSchema)({ ...limits, maxVideoDurationSeconds: 0 }),
    ).toThrow();
  });
});

describe("capabilities", () => {
  it("describes workflows, plan access, defaults, and server limits", () => {
    const capabilities = {
      scope: "organization",
      organizationId: "org-1",
      organizationName: "Team",
      role: "member",
      actions: ["media-read", "media-write", "billing-read"],
      apiVersion: "v1",
      workflows: ["compress", "extract-images", "compare-quality"],
      plan: "free",
      limits,
      codecs: [
        {
          codec: "vp9",
          container: "webm",
          minimumPlan: "free",
          defaultCrf: 42,
          crfRange: { minimum: 0, maximum: 63 },
        },
        {
          codec: "h265",
          container: "mp4",
          minimumPlan: "free",
          defaultCrf: 30,
          crfRange: { minimum: 0, maximum: 51 },
        },
        {
          codec: "av1",
          container: "webm",
          minimumPlan: "basic",
          defaultCrf: 42,
          crfRange: { minimum: 0, maximum: 63 },
        },
      ],
      options,
      defaults: {
        compressionCodecs: ["vp9", "h265"],
        audio: "auto",
        extractionIntervalSeconds: 1,
        extractionFormat: "jpeg",
        comparisonDurationSeconds: 1,
        comparisonSamples: 3,
        comparisonMetrics: ["ssim"],
      },
      controlPlane: {
        preparedSources: true,
        sourceListing: true,
        executionPlans: true,
        jobEvents: true,
        stableArtifacts: true,
        sourceRetentionSeconds: 3600,
        planTtlSeconds: 600,
        artifactAccessGrantTtlSeconds: 300,
      },
      server: {
        maxConcurrentMediaProcesses: 3,
        ffmpegVersion: "7.1.1",
        ffprobeVersion: "7.1.1",
      },
    };

    expect(Schema.decodeUnknownSync(CapabilitiesSchema)(capabilities)).toEqual(capabilities);
    expect(Schema.is(CapabilitiesSchema)({ ...capabilities, organizationId: undefined })).toBe(
      false,
    );
    const {
      scope: _,
      organizationId: _id,
      organizationName: _name,
      role: _role,
      actions: _actions,
      plan: _plan,
      limits: _limits,
      ...common
    } = capabilities;
    const discovery = {
      ...common,
      scope: "public",
      plans: [{ plan: "free", monthlyCredits: 30, limits }],
    };
    expect(PublicCapabilitiesSchema).toBeDefined();
    expect(
      Schema.decodeUnknownSync(PublicCapabilitiesSchema, { onExcessProperty: "error" })(discovery),
    ).toEqual(discovery);
    expect(() =>
      Schema.decodeUnknownSync(PublicCapabilitiesSchema, { onExcessProperty: "error" })({
        ...discovery,
        plan: "free",
      }),
    ).toThrow();
  });
});

describe("capability entitlements", () => {
  it("rejects capabilities that advertise AV1 on Free", () => {
    const decode = Schema.decodeUnknownSync(CapabilitiesSchema);

    expect(() =>
      decode({
        apiVersion: "v1",
        workflows: ["compress"],
        plan: "free",
        limits,
        codecs: [
          {
            codec: "av1",
            container: "webm",
            minimumPlan: "free",
            defaultCrf: 42,
            crfRange: { minimum: 0, maximum: 63 },
          },
        ],
        options,
        defaults: {
          compressionCodecs: ["vp9", "h265"],
          audio: "auto",
          extractionIntervalSeconds: 1,
          extractionFormat: "jpeg",
          comparisonDurationSeconds: 1,
          comparisonSamples: 3,
          comparisonMetrics: ["ssim"],
        },
        controlPlane: {
          preparedSources: true,
          sourceListing: true,
          executionPlans: true,
          jobEvents: true,
          stableArtifacts: true,
          sourceRetentionSeconds: 3600,
          planTtlSeconds: 600,
          artifactAccessGrantTtlSeconds: 300,
        },
        server: {
          maxConcurrentMediaProcesses: 3,
          ffmpegVersion: "7.1.1",
          ffprobeVersion: "7.1.1",
        },
      }),
    ).toThrow();
  });
});
