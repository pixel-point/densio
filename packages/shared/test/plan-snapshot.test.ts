import { Schema } from "effect";
import { expect, it } from "vitest";
import { ExecutionPlanSnapshotSchema, ExecutionPlanStatusSchema } from "../src/index.ts";

const snapshot = {
  organizationId: "org-1",
  createdByUserId: "user-1",
  source: {
    sourceId: "s1",
    filename: "input.mp4",
    declaredBytes: 100,
    verifiedBytes: 100,
    sha256: "a".repeat(64),
    inspection: {
      durationSeconds: 10,
      encodedDimensions: { width: 640, height: 360 },
      displayDimensions: { width: 640, height: 360 },
      rotationDegrees: 0,
      frameRate: { numerator: 60, denominator: 1, framesPerSecond: 60 },
      primaryVideoStream: { index: 0, type: "video", codec: "h264", width: 640, height: 360 },
      audioStreams: [],
      streams: [{ index: 0, type: "video", codec: "h264" }],
    },
  },
  workflow: "compress",
  state: "decision-required",
  requestedOptions: {},
  toolchain: { ffmpegVersion: "7.1", ffprobeVersion: "7.1" },
  intentDigest: "b".repeat(64),
  decision: {
    kind: "frame-rate",
    recommended: { mode: "cap", maximum: 30 },
    source: { numerator: 60, denominator: 1, framesPerSecond: 60 },
  },
};

it("separates immutable plan facts from identity and current availability", () => {
  const decode = Schema.decodeUnknownSync(ExecutionPlanSnapshotSchema, {
    onExcessProperty: "error",
  });
  expect(decode(snapshot)).toEqual(snapshot);
  expect(() => decode({ ...snapshot, policyVersion: "media-policy@1" })).toThrow();
  expect(() => decode({ ...snapshot, planId: "plan-1" })).toThrow();
  const projected = {
    ...snapshot,
    planId: "plan-1",
    createdAt: "2026-09-04T00:00:00.000Z",
    expiresAt: "2026-09-04T01:00:00.000Z",
    availability: "expired",
  };
  const status = Schema.decodeUnknownSync(ExecutionPlanStatusSchema, { onExcessProperty: "error" });
  expect(status(projected)).toEqual(projected);
  expect(() =>
    status({
      ...projected,
      resolve: {
        method: "POST",
        url: "https://api.densio.test/resolve",
        expiresAt: projected.expiresAt,
      },
    }),
  ).toThrow();
});
