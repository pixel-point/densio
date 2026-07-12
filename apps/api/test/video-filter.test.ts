import { describe, expect, it } from "vitest";

import { buildVideoFilters } from "../src/media/video-filter.ts";

describe("video filter planning", () => {
  it("applies a centered aspect-ratio crop before proportional scaling", () => {
    expect(
      buildVideoFilters(
        { width: 1920, height: 1080 },
        {
          crop: { kind: "aspect-ratio", aspectRatio: "1:1" },
          scale: { width: 641 },
        },
      ),
    ).toEqual(["crop=1080:1080:420:0", "scale=640:-2"]);
  });

  it("supports an in-bounds explicit rectangle", () => {
    expect(
      buildVideoFilters(
        { width: 1920, height: 1080 },
        { crop: { kind: "rectangle", width: 800, height: 601, x: 100, y: 20 } },
      ),
    ).toEqual(["crop=800:601:100:20", "scale=-2:600"]);
  });

  it("preserves even source dimensions without an unnecessary filter", () => {
    expect(buildVideoFilters({ width: 1920, height: 1080 })).toEqual([]);
  });

  it("normalizes an odd source dimension while preserving aspect ratio", () => {
    expect(buildVideoFilters({ width: 1921, height: 1080 })).toEqual(["scale=1920:-2"]);
    expect(buildVideoFilters({ width: 1920, height: 1081 })).toEqual(["scale=-2:1080"]);
  });

  it("rejects implicit upscaling and permits an explicit opt-in", () => {
    expect(() =>
      buildVideoFilters({ width: 640, height: 360 }, { scale: { width: 1280 } }),
    ).toThrow(/upscal/i);
    expect(
      buildVideoFilters(
        { width: 640, height: 360 },
        { scale: { width: 1280, allowUpscale: true } },
      ),
    ).toEqual(["scale=1280:-2"]);
  });

  it("rejects out-of-bounds rectangles", () => {
    expect(() =>
      buildVideoFilters(
        { width: 640, height: 360 },
        { crop: { kind: "rectangle", width: 600, height: 300, x: 100, y: 100 } },
      ),
    ).toThrow(/bounds/i);
  });

  it("rejects injection-shaped and non-integer typed values at runtime", () => {
    expect(() =>
      buildVideoFilters(
        { width: 1920, height: 1080 },
        {
          crop: {
            kind: "aspect-ratio",
            aspectRatio: "16:9,drawtext=text=pwned",
          },
        },
      ),
    ).toThrow(/aspect ratio/i);
    expect(() =>
      buildVideoFilters(
        { width: 1920, height: 1080 },
        { scale: { width: "640;rm -rf /" as unknown as number } },
      ),
    ).toThrow(/width/i);
  });

  it("matches the transport aspect-ratio grammar", () => {
    expect(() =>
      buildVideoFilters(
        { width: 1920, height: 1080 },
        { crop: { kind: "aspect-ratio", aspectRatio: "01:1" } },
      ),
    ).toThrow(/aspect ratio/i);
  });

  it("rejects crops too small for an even-dimension video encoder", () => {
    expect(() =>
      buildVideoFilters(
        { width: 640, height: 360 },
        { crop: { kind: "rectangle", width: 1, height: 2, x: 0, y: 0 } },
      ),
    ).toThrow(/width/i);
  });
});
