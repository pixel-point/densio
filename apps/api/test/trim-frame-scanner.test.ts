import { expect, it } from "vitest";
import { makeTrimFrameScanner } from "../src/media/inspection/trim-frame-scanner.ts";

it("handles negative origins, half-open frame ranges, and the one-past-last EOF index", () => {
  const scanner = makeTrimFrameScanner(
    { start: { kind: "frame", frame: 2 }, end: { kind: "frame", frame: 3 } },
    { numerator: 1, denominator: 1000 },
  );
  scanner.push(
    "frame|pts=-900|duration=300\nframe|pts=-600|duration=300\nframe|pts=-300|duration=300\n",
  );
  expect(scanner.finish()).toMatchObject({
    startFrame: 2,
    endFrame: 3,
    frameCount: 1,
    startPts: "-300",
    endPts: "0",
    durationSeconds: 0.3,
  });
});

it("snaps fractional time positions forward using the actual rational time base", () => {
  const scanner = makeTrimFrameScanner(
    {
      start: { kind: "seconds", seconds: 0.03336666666666667 },
      end: { kind: "timecode", timecode: "00:00:00.101" },
    },
    { numerator: 1, denominator: 30000 },
  );
  scanner.push(
    "frame|pts=0|duration=1001\nframe|pts=1001|duration=1001\nframe|pts=2002|duration=1001\nframe|pts=3003|duration=1001\nframe|pts=4004|duration=1001\n",
  );
  expect(scanner.finish()).toMatchObject({
    startFrame: 2,
    endFrame: 4,
    frameCount: 2,
    durationSeconds: 2002 / 30000,
  });
});

it("rejects a time range that snaps to no frames", () => {
  const scanner = makeTrimFrameScanner(
    { start: { kind: "seconds", seconds: 0.01 }, end: { kind: "seconds", seconds: 0.02 } },
    { numerator: 1, denominator: 1000 },
  );
  scanner.push("frame|pts=0|duration=100\nframe|pts=100|duration=100\n");
  expect(() => scanner.finish()).toThrow(expect.objectContaining({ _tag: "TrimRangeInvalid" }));
});

it("reports missing timestamps as unsupported rather than malformed numeric data", () => {
  const scanner = makeTrimFrameScanner(
    { start: { kind: "frame", frame: 0 } },
    { numerator: 1, denominator: 1000 },
  );
  scanner.push("frame|pts=N/A|best_effort_timestamp=N/A|duration=100\n");
  expect(() => scanner.finish()).toThrow(
    expect.objectContaining({ _tag: "TrimTimelineUnsupported" }),
  );
});

it("scans a long timeline in chunks without accumulating frame records", () => {
  const scanner = makeTrimFrameScanner(
    { start: { kind: "frame", frame: 299998 } },
    { numerator: 1, denominator: 30000 },
  );
  for (let frame = 0; frame < 300000; frame += 1)
    scanner.push(`frame|pts=${frame * 1001}|duration=1001\n`);
  expect(scanner.finish()).toMatchObject({ frameCount: 2, startFrame: 299998, endFrame: 300000 });
});
