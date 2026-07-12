import { describe, expect, it } from "vitest";

import { buildImageExtractionPlan } from "../src/media/image-extraction-plan.ts";
import { expectCommandSequence } from "./expect-command.ts";

const baseOptions = {
  inputPath: "/tmp/input.mp4",
  outputPattern: "/tmp/frames/frame-%06d.jpg",
  source: { width: 1920, height: 1080 },
} as const;

describe("image extraction plans", () => {
  it("extracts a JPEG every second by default", () => {
    const plan = buildImageExtractionPlan(baseOptions);

    expect(plan.argv).toEqual([
      "-hide_banner",
      "-nostdin",
      "-y",
      "-i",
      "/tmp/input.mp4",
      "-map",
      "0:v:0",
      "-vf",
      "fps=1/1",
      "-fps_mode",
      "vfr",
      "-c:v",
      "mjpeg",
      "-q:v",
      "2",
      "/tmp/frames/frame-%06d.jpg",
    ]);
  });

  it("applies crop then scale before the extraction cadence", () => {
    const plan = buildImageExtractionPlan({
      ...baseOptions,
      intervalSeconds: 0.5,
      transform: {
        crop: { kind: "rectangle", width: 1000, height: 800, x: 0, y: 0 },
        scale: { height: 400 },
      },
    });

    expectCommandSequence(plan.argv, "-vf", "crop=1000:800:0:0,scale=-2:400,fps=1/0.5");
  });

  it.each([
    ["png", ["-c:v", "png"]],
    ["webp", ["-c:v", "libwebp", "-quality", "90"]],
  ] as const)("uses the %s image encoder", (format, encoderArguments) => {
    const plan = buildImageExtractionPlan({ ...baseOptions, format });

    expectCommandSequence(plan.argv, ...encoderArguments);
  });

  it.each([0, -1, Number.POSITIVE_INFINITY, "1;touch pwned"])(
    "rejects invalid intervals",
    (intervalSeconds) => {
      expect(() =>
        buildImageExtractionPlan({
          ...baseOptions,
          intervalSeconds: intervalSeconds as number,
        }),
      ).toThrow(/interval/i);
    },
  );

  it("rejects an unknown runtime image format", () => {
    expect(() =>
      buildImageExtractionPlan({
        ...baseOptions,
        format: "jpeg;touch pwned" as "jpeg",
      }),
    ).toThrow(/format/i);
  });
});
