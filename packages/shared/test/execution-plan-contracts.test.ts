import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  CreditAmountSchema,
  ExecutionPlanCreateRequestSchema,
  ExecutionPlanCreateResponseSchema,
  ExecutionPlanExecuteRequestSchema,
  ExecutionPlanExecuteResponseSchema,
  ExecutionPlanResolveRequestSchema,
  ExecutionPlanResolveResponseSchema,
  ExecutionPlanStatusSchema,
} from "../src/execution-plan-contracts.ts";

const timestamp = "2026-08-14T10:00:00.000Z";
const laterTimestamp = "2026-08-14T11:00:00.000Z";
const digest = "a".repeat(64);
const source = {
  sourceId: "source-1",
  filename: "launch.mp4",
  declaredBytes: 2_048,
  verifiedBytes: 2_048,
  sha256: "b".repeat(64),
  inspection: {
    durationSeconds: 12.5,
    encodedDimensions: { width: 1_920, height: 1_080 },
    displayDimensions: { width: 1_920, height: 1_080 },
    rotationDegrees: 0,
    frameRate: { numerator: 30_000, denominator: 1_001, framesPerSecond: 29.97002997002997 },
    primaryVideoStream: {
      index: 0,
      type: "video",
      codec: "h264",
      width: 1_920,
      height: 1_080,
    },
    audioStreams: [{ index: 1, type: "audio", codec: "aac", channels: 2 }],
    streams: [
      { index: 0, type: "video", codec: "h264" },
      { index: 1, type: "audio", codec: "aac" },
    ],
  },
};
const planBase = {
  organizationId: "org-1",
  createdByUserId: "user-1",
  planId: "plan-1",
  source,
  constraints: { maxCredits: 2.5, maxOutputBytes: 5_000_000 },
  availability: "available",
  toolchain: { ffmpegVersion: "7.1.1", ffprobeVersion: "7.1.1" },
  intentDigest: digest,
  createdAt: timestamp,
  expiresAt: laterTimestamp,
};
const quote = {
  kind: "exact",
  creditUnits: 250,
  credits: 2.5,
  availableCredits: 10,
};
const warnings = [
  {
    code: "OUTPUT_SIZE_GUARD_IS_POST_ENCODE",
    message: "The output-byte guard is enforced after encoding.",
  },
];
const expectedArtifacts = [
  {
    kind: "video",
    filename: "launch-vp9.webm",
    mediaType: "video/webm",
    codec: "vp9",
    width: 1_920,
    height: 1_080,
  },
];
const execute = {
  method: "POST",
  url: "https://api.densio.test/v1/organizations/org-1/execution-plans/plan-1/execute",
  expiresAt: laterTimestamp,
};

describe("execution plan creation", () => {
  it("pairs each workflow with its typed options", () => {
    const decode = Schema.decodeUnknownSync(ExecutionPlanCreateRequestSchema, {
      onExcessProperty: "error",
    });
    const requests = [
      { sourceId: "source-1", workflow: "compress", options: { codecs: ["vp9"] } },
      { sourceId: "source-1", workflow: "extract-images", options: { format: "webp" } },
      {
        sourceId: "source-1",
        workflow: "compare-quality",
        options: {
          variants: [
            { codec: "vp9", crf: 36 },
            { codec: "vp9", crf: 42 },
          ],
        },
      },
    ];

    expect(requests.map((request) => decode(request))).toEqual(requests);
    expect(() =>
      decode({ sourceId: "source-1", workflow: "compress", options: { format: "png" } }),
    ).toThrow();
    expect(() => decode({ sourceId: "source-1", workflow: "compare-quality" })).toThrow();
  });
});

describe("execution plan status", () => {
  it("decodes ready and decision-required immutable snapshots", () => {
    const decode = Schema.decodeUnknownSync(ExecutionPlanStatusSchema, {
      onExcessProperty: "error",
    });
    const ready = {
      ...planBase,
      state: "ready",
      workflow: "compress",
      requestedOptions: { codecs: ["vp9"] },
      resolvedOptions: {
        codecs: ["vp9"],
        crf: { vp9: 42 },
        audio: "auto",
        frameRate: { mode: "preserve" },
      },
      quote,
      warnings,
      expectedArtifacts,
      execute,
    };
    const decisionRequired = {
      ...planBase,
      state: "decision-required",
      workflow: "compress",
      requestedOptions: { codecs: ["vp9"] },
      decision: {
        kind: "frame-rate",
        recommended: { maximum: 30, mode: "cap" },
        source: { numerator: 60_000, denominator: 1_001, framesPerSecond: 59.94005994005994 },
      },
      resolve: {
        method: "POST",
        url: "https://api.densio.test/v1/organizations/org-1/execution-plans/plan-1/resolve",
        expiresAt: laterTimestamp,
      },
    };

    expect(decode(ready)).toEqual(ready);
    expect(decode(decisionRequired)).toEqual(decisionRequired);
  });

  it("requires the quote, toolchain, digest, expected manifest, and warnings for ready plans", () => {
    const decode = Schema.decodeUnknownSync(ExecutionPlanStatusSchema);
    const ready = {
      ...planBase,
      state: "ready",
      workflow: "compress",
      requestedOptions: {},
      resolvedOptions: {
        codecs: ["vp9"],
        crf: { vp9: 42 },
        audio: "auto",
        frameRate: { mode: "preserve" },
      },
      quote,
      warnings,
      expectedArtifacts,
      execute,
    };

    for (const field of ["quote", "toolchain", "intentDigest", "expectedArtifacts", "warnings"]) {
      const incomplete = { ...ready };
      Reflect.deleteProperty(incomplete, field);
      expect(() => decode(incomplete), field).toThrow();
    }
  });
});

describe("resolved extraction plan status", () => {
  it("requires extraction dimensions in both resolved options and the archive descriptor", () => {
    const decode = Schema.decodeUnknownSync(ExecutionPlanStatusSchema, {
      onExcessProperty: "error",
    });
    const extraction = {
      ...planBase,
      state: "ready",
      workflow: "extract-images",
      requestedOptions: { format: "webp" },
      resolvedOptions: {
        format: "webp",
        intervalSeconds: 1,
        outputDimensions: { width: 1_280, height: 720 },
      },
      quote,
      warnings,
      expectedArtifacts: [
        {
          kind: "image-archive",
          filename: "images.zip",
          mediaType: "application/zip",
          count: 13,
          width: 1_280,
          height: 720,
        },
      ],
      execute,
    };

    expect(decode(extraction)).toEqual(extraction);
    expect(() =>
      decode({
        ...extraction,
        resolvedOptions: { format: "webp", intervalSeconds: 1 },
      }),
    ).toThrow();
  });
});

describe("resolved comparison and expired plan status", () => {
  it("requires comparison resolved options to contain exact numeric sample facts", () => {
    const decode = Schema.decodeUnknownSync(ExecutionPlanStatusSchema, {
      onExcessProperty: "error",
    });
    const comparison = {
      ...planBase,
      state: "ready",
      workflow: "compare-quality",
      requestedOptions: {
        variants: [
          { codec: "vp9", crf: 36 },
          { codec: "h265", crf: 30 },
        ],
        objectiveMetrics: ["ssim"],
        samples: { mode: "auto", count: 2 },
      },
      resolvedOptions: {
        variants: [
          { codec: "vp9", crf: 36 },
          { codec: "h265", crf: 30 },
        ],
        objectiveMetrics: ["ssim"],
        samples: [
          {
            sampleId: "sample-1",
            normalizedStartSeconds: 3.166666666666667,
            actualSampleDurationSeconds: 1,
          },
          {
            sampleId: "sample-2",
            normalizedStartSeconds: 7.333333333333334,
            actualSampleDurationSeconds: 1,
          },
        ],
      },
      quote,
      warnings,
      expectedArtifacts,
      execute,
    };

    expect(decode(comparison)).toEqual(comparison);
    expect(() =>
      decode({
        ...comparison,
        resolvedOptions: {
          variants: comparison.resolvedOptions.variants,
          objectiveMetrics: ["ssim"],
          samples: { mode: "auto", count: 2 },
        },
      }),
    ).toThrow();
  });

  it("does not expose execute or resolve actions after expiry", () => {
    const decode = Schema.decodeUnknownSync(ExecutionPlanStatusSchema, {
      onExcessProperty: "error",
    });
    const expired = {
      ...planBase,
      state: "ready",
      availability: "expired",
      workflow: "compress",
      requestedOptions: { codecs: ["vp9"] },
      resolvedOptions: {
        codecs: ["vp9"],
        crf: { vp9: 42 },
        audio: "auto",
        frameRate: { mode: "preserve" },
      },
      quote,
      warnings,
      expectedArtifacts,
    };

    expect(decode(expired)).toEqual(expired);
    expect(() => decode({ ...expired, execute })).toThrow();
  });
});

describe("execution plan guards and actions", () => {
  it("accepts positive credit values with no more than two decimal places", () => {
    const decode = Schema.decodeUnknownSync(CreditAmountSchema);

    expect(decode(0.01)).toBe(0.01);
    expect(decode(12.34)).toBe(12.34);
    expect(() => decode(0)).toThrow();
    expect(() => decode(1.001)).toThrow();
  });

  it("accepts execution guards and a client reference but no body idempotency field", () => {
    const decode = Schema.decodeUnknownSync(ExecutionPlanExecuteRequestSchema, {
      onExcessProperty: "error",
    });
    const request = {
      maxCredits: 2.5,
      maxOutputBytes: 5_000_000,
      clientReference: "release/launch-video",
    };

    expect(decode(request)).toEqual(request);
    expect(() => decode({ ...request, maxOutputBytes: 0 })).toThrow();
    expect(() => decode({ ...request, maxOutputBytes: 1.5 })).toThrow();
    expect(() => decode({ ...request, idempotencyKey: "must-be-a-header" })).toThrow();
  });

  it("decodes replay-aware resolve and execute responses", () => {
    const resolveRequest = { frameRate: { maximum: 30, mode: "cap" } };
    const ready = {
      ...planBase,
      supersedesPlanId: "plan-1",
      planId: "plan-2",
      state: "ready",
      workflow: "compress",
      requestedOptions: { codecs: ["vp9"] },
      resolvedOptions: {
        codecs: ["vp9"],
        crf: { vp9: 42 },
        audio: "auto",
        frameRate: { maximum: 30, mode: "cap" },
      },
      quote,
      warnings,
      expectedArtifacts,
      execute: {
        ...execute,
        url: "https://api.densio.test/v1/organizations/org-1/execution-plans/plan-2/execute",
      },
    };
    const resolveResponse = { organizationId: "org-1", replayed: true, plan: ready };
    const createResponse = { organizationId: "org-1", replayed: false, plan: ready };
    const { execute: _, ...readyWithoutAction } = ready;
    const expiredReplay = {
      organizationId: "org-1",
      replayed: true,
      plan: {
        ...readyWithoutAction,
        availability: "expired",
      },
    };
    const executeResponse = {
      organizationId: "org-1",
      replayed: true,
      jobId: "job-1",
      state: "queued",
      statusUrl: "https://api.densio.test/v1/organizations/org-1/jobs/job-1",
    };

    expect(Schema.decodeUnknownSync(ExecutionPlanResolveRequestSchema)(resolveRequest)).toEqual(
      resolveRequest,
    );
    expect(Schema.decodeUnknownSync(ExecutionPlanResolveResponseSchema)(resolveResponse)).toEqual(
      resolveResponse,
    );
    expect(Schema.decodeUnknownSync(ExecutionPlanCreateResponseSchema)(createResponse)).toEqual(
      createResponse,
    );
    expect(Schema.decodeUnknownSync(ExecutionPlanCreateResponseSchema)(expiredReplay)).toEqual(
      expiredReplay,
    );
    expect(Schema.decodeUnknownSync(ExecutionPlanResolveResponseSchema)(expiredReplay)).toEqual(
      expiredReplay,
    );
    expect(Schema.decodeUnknownSync(ExecutionPlanExecuteResponseSchema)(executeResponse)).toEqual(
      executeResponse,
    );
    expect(
      Schema.decodeUnknownSync(ExecutionPlanExecuteResponseSchema)({
        ...executeResponse,
        state: "succeeded",
      }),
    ).toEqual({ ...executeResponse, state: "succeeded" });
  });
});
