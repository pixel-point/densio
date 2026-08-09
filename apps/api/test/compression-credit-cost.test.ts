import { describe, expect, it } from "vitest";

import { compressionCreditUnits } from "../src/billing/compression-credit-cost.ts";

describe("compression credit cost", () => {
  it.each([
    ["30-second 480p", 30, 854, 480, 5],
    ["30-second 1080p", 30, 1920, 1080, 10],
    ["five-minute 480p", 300, 854, 480, 20],
    ["five-minute 720p", 300, 1280, 720, 45],
    ["five-minute 1080p", 300, 1920, 1080, 100],
    ["five-minute 4K", 300, 3840, 2160, 400],
  ])("charges %s proportionally", (_label, durationSeconds, width, height, expected) => {
    expect(
      compressionCreditUnits({
        codecCount: 1,
        durationSeconds,
        output: { height, width },
        source: { height, width },
      }),
    ).toBe(expected);
  });

  it("averages source decoding and output encoding resolution", () => {
    expect(
      compressionCreditUnits({
        codecCount: 1,
        durationSeconds: 300,
        output: { height: 1080, width: 1920 },
        source: { height: 2160, width: 3840 },
      }),
    ).toBe(250);
  });

  it("charges each requested codec as a complete encoding pass", () => {
    expect(
      compressionCreditUnits({
        codecCount: 2,
        durationSeconds: 300,
        output: { height: 1080, width: 1920 },
        source: { height: 1080, width: 1920 },
      }),
    ).toBe(200);
  });

  it("rounds up to five-unit increments with a five-unit minimum", () => {
    expect(
      compressionCreditUnits({
        codecCount: 1,
        durationSeconds: 1,
        output: { height: 144, width: 256 },
        source: { height: 144, width: 256 },
      }),
    ).toBe(5);
    expect(
      compressionCreditUnits({
        codecCount: 1,
        durationSeconds: 301,
        output: { height: 1080, width: 1920 },
        source: { height: 1080, width: 1920 },
      }),
    ).toBe(105);
  });
});
