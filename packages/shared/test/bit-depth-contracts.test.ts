import { Schema } from "effect";
import { expect, it } from "vitest";
import {
  CompareQualityOptionsSchema,
  CompressionOptionsSchema,
  ResolvedCompareQualityOptionsSchema,
  ResolvedCompressionOptionsSchema,
} from "../src/index.ts";

const variants = [
  { codec: "vp9", crf: 30 },
  { codec: "h265", crf: 28 },
];

it.each([8, 10])("accepts explicit %i-bit compression and comparison options", (bitDepth) => {
  const compression = { bitDepth };
  const comparison = { bitDepth, variants };
  expect(
    Schema.decodeUnknownSync(CompressionOptionsSchema, { onExcessProperty: "error" })(compression),
  ).toEqual(compression);
  expect(
    Schema.decodeUnknownSync(CompareQualityOptionsSchema, { onExcessProperty: "error" })(
      comparison,
    ),
  ).toEqual(comparison);
});

it.each([0, 9, 12, 10.5, "10", null])("rejects unsupported bit depth %j", (bitDepth) => {
  expect(() => Schema.decodeUnknownSync(CompressionOptionsSchema)({ bitDepth })).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(CompareQualityOptionsSchema)({ bitDepth, variants }),
  ).toThrow();
});

it("preserves legacy resolved options without inserting defaults into immutable snapshots", () => {
  const compression = {
    codecs: ["vp9"],
    crf: { vp9: 30 },
    audio: "remove",
    frameRate: { mode: "preserve" },
  };
  const comparison = {
    variants,
    objectiveMetrics: ["ssim"],
    samples: [{ sampleId: "sample-1", normalizedStartSeconds: 0, actualSampleDurationSeconds: 1 }],
  };
  expect(Schema.decodeUnknownSync(ResolvedCompressionOptionsSchema)(compression)).toEqual(
    compression,
  );
  expect(Schema.decodeUnknownSync(ResolvedCompareQualityOptionsSchema)(comparison)).toEqual(
    comparison,
  );
});
