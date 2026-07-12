import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { CapabilitiesSchema, PlanLimitsSchema } from "../src/index.ts";

const limits = {
  maxVideoDurationSeconds: 10,
  maxUploadBytes: 100_000_000,
  maxExtractionImages: 300,
  maxComparisonCrfs: 8,
  maxComparisonDurationSeconds: 3,
  artifactRetentionSeconds: 86_400,
};

const options = {
  audioModes: ["auto", "keep", "remove"],
  imageFormats: ["jpeg", "png", "webp"],
  cropKinds: ["aspect-ratio", "rectangle"],
  scaleDimensions: ["width", "height"],
  comparisonPositionKinds: ["seconds", "timecode", "frame"],
  comparisonCrfCount: { minimum: 2, maximum: 8 },
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
      apiVersion: "v1",
      workflows: ["compress", "extract-images", "compare-quality"],
      plan: "free",
      limits,
      codecs: [
        {
          codec: "vp9",
          container: "webm",
          minimumPlan: "free",
          defaultCrf: 40,
          crfRange: { minimum: 0, maximum: 63 },
        },
        {
          codec: "h265",
          container: "mp4",
          minimumPlan: "free",
          defaultCrf: 32,
          crfRange: { minimum: 0, maximum: 51 },
        },
        {
          codec: "av1",
          container: "webm",
          minimumPlan: "pro",
          defaultCrf: 36,
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
        comparisonPositionSeconds: 0,
      },
      server: {
        maxConcurrentMediaProcesses: 3,
        ffmpegVersion: "7.1.1",
        ffprobeVersion: "7.1.1",
      },
    };

    expect(Schema.decodeUnknownSync(CapabilitiesSchema)(capabilities)).toEqual(capabilities);
  });

  it("rejects capabilities that advertise AV1 on the free plan", () => {
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
            defaultCrf: 36,
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
          comparisonPositionSeconds: 0,
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
