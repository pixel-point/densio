import { Schema } from "effect";
import { expect, it } from "vitest";
import { CompressionOptionsSchema, JobCreateRequestSchema, JobResultSchema } from "../src/index.ts";

const trim = { start: { kind: "frame", frame: 3 }, end: { kind: "frame", frame: 8 } };

it("retains an exact frame range on compression requests", () => {
  expect(Schema.decodeUnknownSync(CompressionOptionsSchema)({ trim })).toEqual({ trim });
});

it("accepts standalone trim requests and their single-video result", () => {
  const request = {
    sourceId: "source-1",
    workflow: "trim",
    options: { trim, output: { codec: "h265" } },
  };
  expect(Schema.decodeUnknownSync(JobCreateRequestSchema)(request)).toEqual(request);
  expect(
    Schema.decodeUnknownSync(JobResultSchema)({ kind: "trim", artifactIds: ["artifact-1"] }),
  ).toEqual({ kind: "trim", artifactIds: ["artifact-1"] });
});

it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid frame index %s", (frame) => {
  expect(() =>
    Schema.decodeUnknownSync(CompressionOptionsSchema)({
      trim: { start: { kind: "frame", frame } },
    }),
  ).toThrow();
});

it("requires a standalone codec and validates its CRF", () => {
  const decode = Schema.decodeUnknownSync(JobCreateRequestSchema);
  expect(() => decode({ sourceId: "s", workflow: "trim", options: { trim } })).toThrow();
  expect(() =>
    decode({
      sourceId: "s",
      workflow: "trim",
      options: { trim, output: { codec: "h265", crf: 52 } },
    }),
  ).toThrow();
});
