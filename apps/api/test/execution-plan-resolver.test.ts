import { Effect } from "effect";
import { expect, it } from "vitest";

import { PLAN_ENTITLEMENTS } from "../src/auth/entitlements.ts";
import {
  ExecutionPlanCreditGuardExceeded,
  ExecutionPlanEntitlementRejected,
} from "../src/execution-plans/execution-plan-errors.ts";
import { buildExecutionPlan } from "../src/execution-plans/execution-plan-resolver.ts";
import { MEDIA_CODEC_POLICY } from "@densio/shared";

it.each([undefined, 8, 10] as const)(
  "resolves requested bit depth %j in compression and comparison plans",
  async (bitDepth) => {
    const options = bitDepth === undefined ? {} : { bitDepth };
    const compression = await Effect.runPromise(
      buildExecutionPlan({
        ...base,
        entitlements: PLAN_ENTITLEMENTS.free,
        request: { sourceId: "source-1", workflow: "compress", options },
      }),
    );
    const comparison = await Effect.runPromise(
      buildExecutionPlan({
        ...base,
        entitlements: PLAN_ENTITLEMENTS.free,
        request: {
          sourceId: "source-1",
          workflow: "compare-quality",
          options: {
            ...options,
            variants: [
              { codec: "vp9", crf: 30 },
              { codec: "h265", crf: 28 },
            ],
          },
        },
      }),
    );
    for (const plan of [compression, comparison]) {
      expect(plan).toMatchObject({
        state: "ready",
        requestedOptions: options,
        resolvedOptions: { bitDepth: bitDepth ?? 8 },
      });
      if (bitDepth === undefined) expect(plan.requestedOptions).not.toHaveProperty("bitDepth");
    }
  },
);

it("includes bit depth in immutable compression intent", async () => {
  const create = (bitDepth: 8 | 10) =>
    Effect.runPromise(
      buildExecutionPlan({
        ...base,
        entitlements: PLAN_ENTITLEMENTS.free,
        request: { sourceId: "source-1", workflow: "compress", options: { bitDepth } },
      }),
    );
  expect((await create(8)).intentDigest).not.toBe((await create(10)).intentDigest);
});

it("resolves one HLS ladder with the shared CRF default and rendition overrides", async () => {
  const input = {
    ...base,
    entitlements: PLAN_ENTITLEMENTS.free,
    request: { sourceId: "source-1", workflow: "hls" as const },
  };
  const plan = await Effect.runPromise(buildExecutionPlan(input));
  expect(plan).toMatchObject({
    state: "ready",
    workflow: "hls",
    resolvedOptions: {
      codecs: ["h265"],
      preset: "veryslow",
      renditions: [
        { height: 360, crf: { h265: MEDIA_CODEC_POLICY.h265.defaultCrf } },
        { height: 720, crf: { h265: MEDIA_CODEC_POLICY.h265.defaultCrf } },
        { height: 1080, crf: { h265: MEDIA_CODEC_POLICY.h265.defaultCrf } },
      ],
    },
    expectedArtifacts: [
      { kind: "hls-archive", filename: "hls.zip", mediaType: "application/zip", codec: "h265" },
    ],
  });
  const custom = await Effect.runPromise(
    buildExecutionPlan({
      ...input,
      request: {
        ...input.request,
        options: {
          crf: { h265: 28 },
          rateControl: { mode: "crf" },
          ladder: {
            mode: "custom",
            renditions: [{ height: 720 }, { height: 360, crf: { h265: 32 } }],
          },
        },
      },
    }),
  );
  expect(custom).toMatchObject({
    resolvedOptions: {
      renditions: [
        { height: 360, crf: { h265: 32 } },
        { height: 720, crf: { h265: 28 } },
      ],
    },
  });
  if (custom.state === "ready" && custom.workflow === "hls")
    expect(
      custom.resolvedOptions.renditions.every(
        (rendition) => rendition.maxVideoBitrateBps === undefined,
      ),
    ).toBe(true);
});

const base = {
  organizationId: "org-1",
  createdByUserId: "user-1",
  availableCredits: 30,
  createdAt: Date.parse("2026-08-14T10:00:00.000Z"),
  expiresAt: Date.parse("2026-08-14T11:00:00.000Z"),
  planId: "plan-1",
  publicBaseUrl: "https://api.densio.test",
  source: {
    sourceId: "source-1",
    filename: "launch.mp4",
    declaredBytes: 2_048,
    verifiedBytes: 2_048,
    sha256: "b".repeat(64),
    inspection: {
      videoProperties: {
        pixelFormat: "yuv420p",
        sampleAspectRatio: { numerator: 1, denominator: 1 },
        fieldOrder: "progressive",
      },
      durationSeconds: 300,
      encodedDimensions: { width: 1_920, height: 1_080 },
      displayDimensions: { width: 1_920, height: 1_080 },
      rotationDegrees: 0 as const,
      frameRate: {
        numerator: 30,
        denominator: 1,
        framesPerSecond: 30,
      },
      primaryVideoStream: {
        index: 0,
        type: "video" as const,
        codec: "h264",
        width: 1_920,
        height: 1_080,
      },
      audioStreams: [
        { index: 1, type: "audio" as const, codec: "aac", channels: 2, sampleRate: 48_000 },
      ],
      streams: [
        { index: 0, type: "video" as const, codec: "h264" },
        { index: 1, type: "audio" as const, codec: "aac" },
      ],
    },
  },
  toolchain: { ffmpegVersion: "7.1.1", ffprobeVersion: "7.1.1" },
};

it("rejects missing requested audio and requested HLS upscaling before admission", async () => {
  const input = {
    ...base,
    entitlements: PLAN_ENTITLEMENTS.free,
    request: { sourceId: "source-1", workflow: "hls" as const },
  };
  await expect(
    Effect.runPromise(
      buildExecutionPlan({
        ...input,
        source: { ...base.source, inspection: { ...base.source.inspection, audioStreams: [] } },
        request: { ...input.request, options: { audio: "keep" } },
      }),
    ),
  ).rejects.toMatchObject({ _tag: "ExecutionPlanInvalidOptions" });
  await expect(
    Effect.runPromise(
      buildExecutionPlan({
        ...input,
        request: {
          ...input.request,
          options: { ladder: { mode: "custom", renditions: [{ height: 1081 }] } },
        },
      }),
    ),
  ).rejects.toMatchObject({ _tag: "ExecutionPlanInvalidOptions" });
});

it.each([{ colorTransfer: "smpte2084" }, { colorTransfer: "arib-std-b67" }, { fieldOrder: "tt" }])(
  "rejects HLS sources requiring unsupported transforms %j",
  async (properties) => {
    await expect(
      Effect.runPromise(
        buildExecutionPlan({
          ...base,
          entitlements: PLAN_ENTITLEMENTS.free,
          source: {
            ...base.source,
            inspection: {
              ...base.source.inspection,
              videoProperties: { ...base.source.inspection.videoProperties, ...properties },
            },
          },
          request: { sourceId: "source-1", workflow: "hls" },
        }),
      ),
    ).rejects.toMatchObject({ _tag: "HlsSourceUnsupported" });
  },
);

it("returns an immutable exact compression quote and expected artifact manifest", async () => {
  const plan = await Effect.runPromise(
    buildExecutionPlan({
      ...base,
      entitlements: PLAN_ENTITLEMENTS.free,
      request: {
        sourceId: "source-1",
        workflow: "compress",
        options: { codecs: ["vp9"], audio: "remove" },
        constraints: { maxCredits: 1, maxOutputBytes: 10_000_000 },
      },
    }),
  );

  expect(plan).toMatchObject({
    state: "ready",
    workflow: "compress",
    quote: { kind: "exact", creditUnits: 100, credits: 1, availableCredits: 30 },
    resolvedOptions: {
      codecs: ["vp9"],
      crf: { vp9: 42 },
      audio: "remove",
      frameRate: { mode: "preserve" },
    },
    expectedArtifacts: [
      {
        kind: "video",
        filename: "video-vp9.webm",
        mediaType: "video/webm",
        codec: "vp9",
        width: 1_920,
        height: 1_080,
        durationSeconds: 300,
      },
    ],
    warnings: [expect.objectContaining({ code: "OUTPUT_SIZE_GUARD_IS_POST_ENCODE" })],
  });
  expect(plan.intentDigest).toMatch(/^[a-f0-9]{64}$/);
});

it("enforces the configured comparison duration advertised by capabilities", async () => {
  await expect(
    Effect.runPromise(
      buildExecutionPlan({
        ...base,
        entitlements: PLAN_ENTITLEMENTS.free,
        maxComparisonSeconds: 1,
        request: {
          workflow: "compare-quality",
          sourceId: "source-1",
          options: {
            variants: [
              { codec: "vp9", crf: 30 },
              { codec: "vp9", crf: 40 },
            ],
            durationSeconds: 2,
          },
        },
      }),
    ),
  ).rejects.toMatchObject({ _tag: "ExecutionPlanInvalidOptions" });
});

it("hashes exact resolved intent and excludes the account balance snapshot", async () => {
  const request = {
    sourceId: "source-1",
    workflow: "compress" as const,
    options: { codecs: ["vp9" as const], frameRate: { mode: "preserve" as const } },
  };
  const [original, anotherBalance, differentResolvedOutput] = await Effect.runPromise(
    Effect.all([
      buildExecutionPlan({
        ...base,
        entitlements: PLAN_ENTITLEMENTS.free,
        request,
      }),
      buildExecutionPlan({
        ...base,
        availableCredits: 29,
        entitlements: PLAN_ENTITLEMENTS.free,
        request,
      }),
      buildExecutionPlan({
        ...base,
        source: {
          ...base.source,
          inspection: {
            ...base.source.inspection,
            displayDimensions: { width: 1_280, height: 720 },
            encodedDimensions: { width: 1_280, height: 720 },
          },
        },
        entitlements: PLAN_ENTITLEMENTS.free,
        request,
      }),
    ]),
  );

  expect(anotherBalance.intentDigest).toBe(original.intentDigest);
  expect(differentResolvedOutput.intentDigest).not.toBe(original.intentDigest);
});

it("changes the digest when exact comparison sample geometry changes", async () => {
  const request = {
    sourceId: "source-1",
    workflow: "compare-quality" as const,
    options: {
      variants: [
        { codec: "vp9" as const, crf: 36 },
        { codec: "h265" as const, crf: 30 },
      ],
      objectiveMetrics: ["ssim" as const],
      samples: { mode: "auto" as const, count: 2 },
    },
  };
  const [original, shorter] = await Effect.runPromise(
    Effect.all([
      buildExecutionPlan({ ...base, entitlements: PLAN_ENTITLEMENTS.free, request }),
      buildExecutionPlan({
        ...base,
        source: {
          ...base.source,
          inspection: { ...base.source.inspection, durationSeconds: 299 },
        },
        entitlements: PLAN_ENTITLEMENTS.free,
        request,
      }),
    ]),
  );

  expect(original).toMatchObject({
    resolvedOptions: {
      samples: [
        {
          sampleId: "sample-1",
          normalizedStartSeconds: 99.5,
          actualSampleDurationSeconds: 1,
        },
        {
          sampleId: "sample-2",
          normalizedStartSeconds: 199.5,
          actualSampleDurationSeconds: 1,
        },
      ],
    },
  });
  expect(shorter.intentDigest).not.toBe(original.intentDigest);
});

it("requires a durable decision before planning an unspecified high frame rate", async () => {
  const plan = await Effect.runPromise(
    buildExecutionPlan({
      ...base,
      source: {
        ...base.source,
        inspection: {
          ...base.source.inspection,
          frameRate: { numerator: 60, denominator: 1, framesPerSecond: 60 },
        },
      },
      entitlements: PLAN_ENTITLEMENTS.free,
      request: { sourceId: "source-1", workflow: "compress", options: { codecs: ["vp9"] } },
    }),
  );

  expect(plan).toMatchObject({
    state: "decision-required",
    decision: {
      kind: "frame-rate",
      recommended: { mode: "cap", maximum: 30 },
      source: { numerator: 60, denominator: 1, framesPerSecond: 60 },
    },
  });
});

it("rejects a maximum-credit guard below the exact quote", async () => {
  const error = await Effect.runPromise(
    Effect.flip(
      buildExecutionPlan({
        ...base,
        entitlements: PLAN_ENTITLEMENTS.free,
        request: {
          sourceId: "source-1",
          workflow: "compress",
          options: { codecs: ["vp9"] },
          constraints: { maxCredits: 0.99 },
        },
      }),
    ),
  );

  expect(error).toBeInstanceOf(ExecutionPlanCreditGuardExceeded);
  expect(error).toMatchObject({ maxCredits: 0.99, requiredCredits: 1 });
});

it("validates every matrix codec against the account entitlement", async () => {
  const error = await Effect.runPromise(
    Effect.flip(
      buildExecutionPlan({
        ...base,
        entitlements: PLAN_ENTITLEMENTS.free,
        request: {
          sourceId: "source-1",
          workflow: "compare-quality",
          options: {
            variants: [
              { codec: "vp9", crf: 42 },
              { codec: "av1", crf: 42 },
            ],
            objectiveMetrics: ["ssim"],
          },
        },
      }),
    ),
  );

  expect(error).toBeInstanceOf(ExecutionPlanEntitlementRejected);
  expect(error).toMatchObject({ codec: "av1" });
});

it("resolves extraction dimensions in its exact manifest", async () => {
  const extraction = await Effect.runPromise(
    buildExecutionPlan({
      ...base,
      entitlements: PLAN_ENTITLEMENTS.free,
      request: {
        sourceId: "source-1",
        workflow: "extract-images",
        options: { format: "webp", intervalSeconds: 10 },
      },
    }),
  );
  expect(extraction).toMatchObject({
    state: "ready",
    quote: { creditUnits: 5, credits: 0.05 },
    resolvedOptions: {
      format: "webp",
      intervalSeconds: 10,
      outputDimensions: { width: 1_920, height: 1_080 },
    },
    expectedArtifacts: [
      {
        kind: "image-archive",
        filename: "images.zip",
        count: 30,
        width: 1_920,
        height: 1_080,
      },
    ],
  });
});

it("quotes a matrix from its exact resolved samples and manifest", async () => {
  const comparison = await Effect.runPromise(
    buildExecutionPlan({
      ...base,
      entitlements: PLAN_ENTITLEMENTS.free,
      request: {
        sourceId: "source-1",
        workflow: "compare-quality",
        options: {
          variants: [
            { codec: "vp9", crf: 36 },
            { codec: "h265", crf: 30 },
          ],
          objectiveMetrics: ["ssim", "psnr"],
        },
      },
    }),
  );

  expect(comparison).toMatchObject({
    state: "ready",
    quote: { creditUnits: 5, credits: 0.05 },
    resolvedOptions: {
      samples: [
        {
          sampleId: "sample-1",
          normalizedStartSeconds: 74.5,
          actualSampleDurationSeconds: 1,
        },
        {
          sampleId: "sample-2",
          normalizedStartSeconds: 149.5,
          actualSampleDurationSeconds: 1,
        },
        {
          sampleId: "sample-3",
          normalizedStartSeconds: 224.5,
          actualSampleDurationSeconds: 1,
        },
      ],
      objectiveMetrics: ["ssim", "psnr"],
    },
    expectedArtifacts: [
      {
        filename: "comparison-vp9-crf-36.webm",
        kind: "preview-video",
        width: 1_920,
        height: 1_080,
        durationSeconds: 3,
      },
      {
        filename: "comparison-vp9-crf-36.jpg",
        kind: "preview-image",
        width: 1_920,
        height: 1_080,
      },
      {
        filename: "comparison-h265-crf-30.mp4",
        kind: "preview-video",
        width: 1_920,
        height: 1_080,
        durationSeconds: 3,
      },
      {
        filename: "comparison-h265-crf-30.jpg",
        kind: "preview-image",
        width: 1_920,
        height: 1_080,
      },
    ],
  });
});

it("snapshots storage intent independently of compression and includes it in the plan digest", async () => {
  const input = {
    ...base,
    entitlements: PLAN_ENTITLEMENTS.basic,
    request: {
      sourceId: "source-1",
      workflow: "compress" as const,
      options: { codecs: ["vp9" as const], frameRate: { mode: "preserve" as const } },
    },
  };
  const temporary = await Effect.runPromise(buildExecutionPlan(input));
  expect(temporary).toMatchObject({ storage: { destination: { kind: "temporary" } } });
  const storage = {
    destination: { kind: "managed" as const },
    visibility: "public" as const,
    displayName: "Homepage Hero",
    filenameStem: "homepage-hero",
    targetId: "r2-test",
    publicOrigin: "https://media.example.test",
    keyPrefix: "",
    files: [{ codec: "vp9" as const, filename: "homepage-hero-vp9.webm" }],
  };
  const stored = await Effect.runPromise(buildExecutionPlan({ ...input, storage }));
  expect(stored).toMatchObject({ storage });
  expect(stored.intentDigest).not.toBe(temporary.intentDigest);
});

it.each([1920, 1921])("quotes and predicts the encoded clip for source width %i", async (width) => {
  const trim = {
    start: { kind: "frame" as const, frame: 300 },
    end: { kind: "frame" as const, frame: 600 },
  };
  const resolvedTrim = {
    videoStreamIndex: 0,
    startFrame: 300,
    endFrame: 600,
    frameCount: 300,
    startPts: "10000",
    endPts: "20000",
    timeBase: { numerator: 1, denominator: 1000 },
    durationSeconds: 10,
  };
  const input = {
    ...base,
    source: {
      ...base.source,
      inspection: {
        ...base.source.inspection,
        displayDimensions: { width, height: width === 1920 ? 1080 : 1081 },
      },
    },
    entitlements: PLAN_ENTITLEMENTS.free,
    resolvedTrim,
  };
  const compressed = await Effect.runPromise(
    buildExecutionPlan({
      ...input,
      request: { sourceId: "source-1", workflow: "compress", options: { trim, codecs: ["h265"] } },
    }),
  );
  expect(compressed).toMatchObject({
    quote: { credits: 0.05 },
    resolvedOptions: { trim: resolvedTrim },
    expectedArtifacts: [{ durationSeconds: 10 }],
  });
  const standalone = await Effect.runPromise(
    buildExecutionPlan({
      ...input,
      request: {
        sourceId: "source-1",
        workflow: "trim",
        options: { trim, output: { codec: "h265" } },
      },
    }),
  );
  expect(standalone).toMatchObject({
    workflow: "trim",
    quote: { credits: 0.05 },
    expectedArtifacts: [{ width: 1920, height: 1080, durationSeconds: 10 }],
    resolvedOptions: {
      trim: resolvedTrim,
      output: { codec: "h265", crf: MEDIA_CODEC_POLICY.h265.defaultCrf },
    },
  });
});
