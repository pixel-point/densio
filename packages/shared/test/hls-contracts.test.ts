import {
  ExecutionPlanCreateRequestSchema,
  JobCreateRequestSchema,
} from "../src/execution-plan-contracts.ts";
import { Schema } from "effect";
import { expect, it } from "vitest";

it("accepts omitted HLS options and explicit CRF ladders through both submission paths", () => {
  const decode = Schema.decodeUnknownSync(ExecutionPlanCreateRequestSchema, {
    onExcessProperty: "error",
  });
  expect(() => decode({ sourceId: "source-1", workflow: "hls" })).not.toThrow();
  expect(
    Schema.decodeUnknownSync(JobCreateRequestSchema)({
      sourceId: "source-1",
      workflow: "hls",
      clientReference: "launch",
      options: {
        crf: { h265: 28 },
        ladder: {
          mode: "custom",
          renditions: [{ height: 720 }, { height: 360, crf: { h265: 30 } }],
        },
      },
    }),
  ).toMatchObject({ workflow: "hls", clientReference: "launch" });
});

it.each([
  { codecs: ["h264"] },
  { codecs: ["vp9"] },
  { codecs: ["av1"] },
  { crf: { h265: 52 } },
  { ladder: { mode: "custom", renditions: [] } },
  {
    rateControl: { mode: "crf" },
    ladder: { mode: "custom", renditions: [{ height: 720, maxVideoBitrateBps: 1000000 }] },
  },
])("rejects unsupported HLS options %j", (options) => {
  expect(() =>
    Schema.decodeUnknownSync(ExecutionPlanCreateRequestSchema, { onExcessProperty: "error" })({
      sourceId: "source-1",
      workflow: "hls",
      options,
    }),
  ).toThrow();
});
