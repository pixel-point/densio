import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  PreparedSourceCreateRequestSchema,
  PreparedSourceCreateResponseSchema,
  PreparedSourceDeletionReceiptSchema,
  PreparedSourceStatusSchema,
  SourceActionSchema,
} from "../src/source-contracts.ts";

const timestamp = "2026-08-14T10:00:00.000Z";
const laterTimestamp = "2026-08-15T10:00:00.000Z";
const digest = "a".repeat(64);
const sourceBase = {
  organizationId: "org-1",
  createdByUserId: "user-1",
  sourceId: "source-1",
  filename: "launch reel.mp4",
  declaredBytes: 1_024,
  createdAt: timestamp,
  updatedAt: timestamp,
  expiresAt: laterTimestamp,
};
const upload = {
  method: "PUT",
  url: "https://api.densio.test/v1/organizations/org-1/sources/source-1/upload",
  expiresAt: laterTimestamp,
};
const inspection = {
  durationSeconds: 12.5,
  encodedDimensions: { width: 1_920, height: 1_080 },
  displayDimensions: { width: 1_080, height: 1_920 },
  rotationDegrees: 90,
  frameRate: { numerator: 60_000, denominator: 1_001, framesPerSecond: 59.94005994005994 },
  primaryVideoStream: {
    index: 0,
    type: "video",
    codec: "h264",
    width: 1_920,
    height: 1_080,
  },
  audioStreams: [{ index: 1, type: "audio", codec: "aac", channels: 2, sampleRate: 48_000 }],
  streams: [
    { index: 0, type: "video", codec: "h264" },
    { index: 1, type: "audio", codec: "aac" },
  ],
};

describe("prepared source creation", () => {
  it("accepts a safe filename and positive byte declaration", () => {
    const request = { filename: "launch reel.mp4", bytes: 1_024 };

    expect(Schema.decodeUnknownSync(PreparedSourceCreateRequestSchema)(request)).toEqual(request);
  });

  it("rejects paths and non-positive byte declarations", () => {
    const decode = Schema.decodeUnknownSync(PreparedSourceCreateRequestSchema);

    expect(() => decode({ filename: "../secret.mp4", bytes: 1_024 })).toThrow();
    expect(() => decode({ filename: "folder/input.mp4", bytes: 1_024 })).toThrow();
    expect(() => decode({ filename: "input.mp4", bytes: 0 })).toThrow();
  });
});

describe("prepared source status", () => {
  it("decodes every state with its state-specific fields", () => {
    const decode = Schema.decodeUnknownSync(PreparedSourceStatusSchema);
    const problem = {
      type: "https://densio.test/problems/source-inspection-failed",
      title: "Source inspection failed",
      status: 422,
      detail: "The upload does not contain a supported video stream.",
      schemaVersion: 1,
      code: "SOURCE_INSPECTION_FAILED",
      retryable: false,
      suggestedAction: "Upload a supported video file.",
      correlationId: "request-1",
    };
    const statuses = [
      { ...sourceBase, state: "awaiting-upload", upload },
      { ...sourceBase, state: "inspecting", verifiedBytes: 1_024, sha256: digest },
      {
        ...sourceBase,
        state: "ready",
        verifiedBytes: 1_024,
        sha256: digest,
        inspection,
      },
      { ...sourceBase, state: "failed", problem },
      { ...sourceBase, state: "expired" },
    ];

    expect(statuses.map((status) => decode(status))).toEqual(statuses);
    expect(() => decode({ ...sourceBase, state: "inspecting", verifiedBytes: 1_024 })).toThrow();
    expect(() => decode({ ...sourceBase, state: "ready", sha256: digest })).toThrow();
    expect(() => decode({ ...sourceBase, state: "failed" })).toThrow();
  });

  it("accepts normalized rational frame rate, orientation, and stream facts", () => {
    const ready = {
      ...sourceBase,
      state: "ready",
      verifiedBytes: 1_024,
      sha256: digest,
      inspection,
    };

    expect(Schema.decodeUnknownSync(PreparedSourceStatusSchema)(ready)).toEqual(ready);
  });

  it("reports replay and exposes upload only while upload is legal", () => {
    const decode = Schema.decodeUnknownSync(PreparedSourceCreateResponseSchema, {
      onExcessProperty: "error",
    });
    const awaiting = {
      organizationId: "org-1",
      replayed: false,
      source: { ...sourceBase, state: "awaiting-upload", upload },
    };
    const ready = {
      replayed: true,
      organizationId: "org-1",
      source: {
        ...sourceBase,
        state: "ready",
        verifiedBytes: 1_024,
        sha256: digest,
        inspection,
      },
    };

    expect(decode(awaiting)).toEqual(awaiting);
    expect(decode(ready)).toEqual(ready);
    expect(() => decode({ ...ready, source: { ...ready.source, upload } })).toThrow();
  });
});

describe("prepared source actions and deletion", () => {
  it("rejects malformed action URLs and timestamps", () => {
    const decode = Schema.decodeUnknownSync(SourceActionSchema);

    expect(decode(upload)).toEqual(upload);
    expect(() =>
      decode({ ...upload, url: "/v1/organizations/org-1/sources/source-1/upload" }),
    ).toThrow();
    expect(() => decode({ ...upload, expiresAt: "tomorrow" })).toThrow();
  });

  it("decodes an idempotent expiry receipt", () => {
    const receipt = {
      organizationId: "org-1",
      sourceId: "source-1",
      state: "deleted",
      deletedAt: timestamp,
    };
    const decode = Schema.decodeUnknownSync(PreparedSourceDeletionReceiptSchema);

    expect(decode(receipt)).toEqual(receipt);
    expect(() => decode({ ...receipt, deletedAt: "now" })).toThrow();
  });
});
