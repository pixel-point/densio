import { describe, expect, it } from "vitest";

import { parsePsnrMetric, parseSsimMetric } from "../src/media/quality-comparison-metrics.ts";

describe("quality comparison metric parsing", () => {
  it("parses the aggregate finite SSIM score", () => {
    expect(parseSsimMetric("SSIM Y:0.99 U:0.98 V:0.97 All:0.982341 (17.7)")).toBe(0.982341);
  });

  it("parses finite and perfect-match PSNR explicitly", () => {
    expect(parsePsnrMetric("PSNR y:43.1 u:45.2 v:44.8 average:43.718 min:40 max:48")).toBe(43.718);
    expect(parsePsnrMetric("PSNR y:inf u:inf v:inf average:inf min:inf max:inf")).toBe("infinite");
  });

  it.each([
    ["SSIM", "SSIM All:not-a-number"],
    ["SSIM", "SSIM All:1.01"],
    ["PSNR", "PSNR average:0"],
    ["PSNR", "no metric here"],
  ])("rejects malformed %s output", (metric, output) => {
    const parse = metric === "SSIM" ? parseSsimMetric : parsePsnrMetric;

    expect(() => parse(output)).toThrow(new RegExp(metric, "i"));
  });
});
