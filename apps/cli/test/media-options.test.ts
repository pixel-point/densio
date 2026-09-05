import { describe, expect, it } from "vitest";
import { parsePlanCreate } from "../src/plan-options.ts";

describe("canonical media planning options", () => {
  it.each([
    [["compress", "--frame-rate", "preserve"], { frameRate: { mode: "preserve" } }],
    [["compress", "--frame-rate", "cap-30"], { frameRate: { mode: "cap", maximum: 30 } }],
    [
      ["extract-images", "--interval", "0.5", "--format", "webp", "--height", "360"],
      { format: "webp", intervalSeconds: 0.5, transform: { scale: { height: 360 } } },
    ],
    [
      [
        "compare-quality",
        "--matrix",
        "h265:24,30",
        "--sample-duration",
        "3",
        "--sample",
        "01:02.500",
        "--crop-rect",
        "640:360:10:20",
      ],
      {
        variants: [
          { codec: "h265", crf: 24 },
          { codec: "h265", crf: 30 },
        ],
        durationSeconds: 3,
        samples: { mode: "positions", positions: [{ kind: "timecode", timecode: "01:02.500" }] },
        transform: { crop: { kind: "rectangle", width: 640, height: 360, x: 10, y: 20 } },
      },
    ],
  ])("parses workflow-specific options %j", (argv, options) => {
    expect(parsePlanCreate(["source-1", ...argv]).request.options).toEqual(options);
  });
});

describe("matrix planning options", () => {
  it("preserves candidate and metric order for a multi-codec matrix", () => {
    expect(
      parsePlanCreate([
        "source-1",
        "compare-quality",
        "--matrix",
        "vp9:30,36",
        "--matrix",
        "av1:40,45",
        "--samples",
        "3",
        "--metric",
        "ssim,psnr",
      ]).request.options,
    ).toEqual({
      variants: [
        { codec: "vp9", crf: 30 },
        { codec: "vp9", crf: 36 },
        { codec: "av1", crf: 40 },
        { codec: "av1", crf: 45 },
      ],
      samples: { mode: "auto", count: 3 },
      objectiveMetrics: ["ssim", "psnr"],
    });
  });

  it("preserves ordered explicit positions and leaves metric defaults to the API", () => {
    expect(
      parsePlanCreate([
        "source-1",
        "compare-quality",
        "--matrix",
        "h265:24,30",
        "--sample",
        "12.5",
        "--sample",
        "01:02.500",
        "--sample",
        "frame:120",
      ]).request.options,
    ).toEqual({
      variants: [
        { codec: "h265", crf: 24 },
        { codec: "h265", crf: 30 },
      ],
      samples: {
        mode: "positions",
        positions: [
          { kind: "seconds", seconds: 12.5 },
          { kind: "timecode", timecode: "01:02.500" },
          { kind: "frame", frame: 120 },
        ],
      },
    });
  });

  it.each([
    ["compress", "--frame-rate", "60"],
    ["compress", "--timeout", "0"],
    ["compress", "--client-reference", "hero"],
    ["compress", "--force"],
    ["compress", "--output-dir", "public/media"],
    ["compare-quality", "--matrix", "vp9:30,36", "--codec", "vp9"],
    ["compare-quality", "--matrix", "vp9:30,36", "--samples", "3", "--sample", "12"],
  ])("rejects invalid and execution-only planning flags %j", (...argv) => {
    expect(() => parsePlanCreate(["source-1", ...argv])).toThrow();
  });
});
