import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ArtifactReceiptSchema,
  CompareQualityOptionsSchema,
  JobStateSchema,
  JobStatusSchema,
  JobResultSchema,
  PreparedSourceCreateRequestSchema,
  PreparedSourceStatusSchema,
  PreparedSourceListQuerySchema,
  PreparedSourceDeletionReceiptSchema,
  ResolvedCompressionOptionsSchema,
} from "../src/index.ts";

describe("canonical control-plane boundaries", () => {
  it("requires defaults to be resolved before compression reaches the worker", () => {
    const decode = Schema.decodeUnknownSync(ResolvedCompressionOptionsSchema);
    expect(() => decode({ codecs: ["vp9"] })).toThrow();
    expect(
      decode({ codecs: ["vp9"], crf: { vp9: 42 }, audio: "auto", frameRate: { mode: "preserve" } }),
    ).toMatchObject({ crf: { vp9: 42 } });
    expect(() =>
      decode({ codecs: ["vp9"], crf: {}, audio: "auto", frameRate: { mode: "preserve" } }),
    ).toThrow();
  });
  it("lists source tombstones and distinguishes deletion from expiry", () => {
    expect(
      Schema.decodeUnknownSync(PreparedSourceListQuerySchema)({ state: "deleted", limit: 25 }),
    ).toEqual({ state: "deleted", limit: 25 });
    expect(
      Schema.decodeUnknownSync(PreparedSourceDeletionReceiptSchema)({
        organizationId: "org-1",
        sourceId: "source-1",
        state: "deleted",
        deletedAt: "2026-09-04T00:00:00.000Z",
      }).state,
    ).toBe("deleted");
  });
  it("accepts a matrix comparison with one explicit sample", () => {
    const request = {
      variants: [
        { codec: "vp9", crf: 36 },
        { codec: "h265", crf: 24 },
      ],
      samples: { mode: "positions", positions: [{ kind: "frame", frame: 172 }] },
      objectiveMetrics: ["ssim"],
    };
    expect(
      Schema.decodeUnknownSync(CompareQualityOptionsSchema, {
        onExcessProperty: "error",
      })(request),
    ).toEqual(request);
  });

  it("rejects the old single-codec comparison shape", () => {
    expect(() =>
      Schema.decodeUnknownSync(CompareQualityOptionsSchema)({
        codec: "vp9",
        crfs: [36, 42],
      }),
    ).toThrow();
  });
});

describe("canonical lifecycle and artifact boundaries", () => {
  it("limits jobs to plan execution states", () => {
    const decode = Schema.decodeUnknownSync(JobStateSchema);
    expect(decode("preparing")).toBe("preparing");
    expect(decode("publishing")).toBe("publishing");
    for (const removed of ["awaiting-upload", "awaiting-decision", "expired"]) {
      expect(() => decode(removed)).toThrow();
    }
  });

  it("represents source finalization and explicit deletion directly", () => {
    const base = {
      organizationId: "org-1",
      createdByUserId: "user-1",
      sourceId: "source-1",
      filename: "input.mp4",
      declaredBytes: 100,
      createdAt: "2026-09-04T00:00:00.000Z",
      updatedAt: "2026-09-04T00:00:00.000Z",
      expiresAt: "2026-09-05T00:00:00.000Z",
    };
    const decode = Schema.decodeUnknownSync(PreparedSourceStatusSchema);
    expect(
      decode({ ...base, state: "finalizing", verifiedBytes: 100, sha256: "a".repeat(64) }).state,
    ).toBe("finalizing");
    expect(decode({ ...base, state: "deleted" }).state).toBe("deleted");
  });

  it("uses the same safe filename boundary for sources and artifacts", () => {
    const source = Schema.decodeUnknownSync(PreparedSourceCreateRequestSchema);
    const artifact = Schema.decodeUnknownSync(ArtifactReceiptSchema);
    for (const filename of [".", "..", "bad\u0000.mp4", "x".repeat(256)]) {
      expect(() => source({ filename, bytes: 1 })).toThrow();
      expect(() =>
        artifact({
          organizationId: "org-1",
          id: "a",
          kind: "video",
          filename,
          mediaType: "video/mp4",
          bytes: 1,
          sha256: "a".repeat(64),
          retainedUntil: "2026-09-05T00:00:00.000Z",
        }),
      ).toThrow();
    }
  });

  it("requires canonical job progress and plan/source identity without duplicate percent", () => {
    const status = {
      organizationId: "org-1",
      createdByUserId: "user-1",
      id: "job-1",
      sourceId: "source-1",
      executionPlanId: "plan-1",
      workflow: "compress",
      plan: "free",
      state: "preparing",
      createdAt: "2026-09-04T00:00:00.000Z",
      updatedAt: "2026-09-04T00:00:00.000Z",
      actions: [],
      progress: { phase: "preparing", percent: 0, attempt: 0, revision: 0 },
    };
    const decode = Schema.decodeUnknownSync(JobStatusSchema, { onExcessProperty: "error" });
    expect(decode(status)).toEqual(status);
    expect(() => decode({ ...status, progressPercent: 0 })).toThrow();
    expect(() => decode({ ...status, progress: undefined })).toThrow();
  });

  it("stores stable output references rather than bearer URLs in media results", () => {
    const decode = Schema.decodeUnknownSync(JobResultSchema, { onExcessProperty: "error" });
    const compression = { kind: "compress", artifactIds: ["artifact-1"], html: "<video></video>" };
    const extraction = {
      kind: "extract-images",
      archiveArtifactId: "artifact-2",
      imageCount: 2,
      intervalSeconds: 1,
    };
    expect(decode(compression)).toEqual(compression);
    expect(decode(extraction)).toEqual(extraction);
    expect(() => decode({ ...compression, previewHtml: "https://secret.test/" })).toThrow();
  });
});
