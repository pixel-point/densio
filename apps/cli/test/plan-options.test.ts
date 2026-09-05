import { describe, expect, it } from "vitest";

import { parsePlanCreate } from "../src/plan-options.ts";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

it.each(["plans create", "jobs create"] as const)(
  "passes explicit bit depth through %s",
  (command) => {
    for (const bitDepth of [8, 10]) {
      expect(
        parsePlanCreate(["source-1", "compress", "--bit-depth", String(bitDepth)], command).request
          .options,
      ).toEqual({ bitDepth });
      expect(
        parsePlanCreate(
          ["source-1", "compare-quality", "--matrix", "vp9:30,40", "--bit-depth", String(bitDepth)],
          command,
        ).request.options,
      ).toMatchObject({ bitDepth });
    }
    expect(parsePlanCreate(["source-1", "compress"], command).request.options).not.toHaveProperty(
      "bitDepth",
    );
  },
);

it.each(["12", "9", "10.5", "auto", ""])("rejects invalid CLI bit depth %j", (value) => {
  expect(() => parsePlanCreate(["source-1", "compress", "--bit-depth", value])).toThrow();
  expect(() =>
    parsePlanCreate(["source-1", "compare-quality", "--matrix", "vp9:30,40", "--bit-depth", value]),
  ).toThrow();
});

it("rejects repeated bit-depth flags and bit depth for unrelated workflows", () => {
  expect(() =>
    parsePlanCreate(["source-1", "compress", "--bit-depth", "8", "--bit-depth", "10"]),
  ).toThrow();
  expect(() => parsePlanCreate(["source-1", "hls", "--bit-depth", "10"])).toThrow();
  expect(() => parsePlanCreate(["source-1", "extract-images", "--bit-depth", "10"])).toThrow();
});

describe("canonical plan options", () => {
  it("parses source identity, workflow options, and guards once", () => {
    expect(
      parsePlanCreate([
        "source-1",
        "compress",
        "--codec",
        "vp9",
        "--vp9-crf",
        "32",
        "--frame-rate",
        "cap-30",
        "--width",
        "640",
        "--max-credits",
        "0.5",
        "--idempotency-key",
        "plan-1",
      ]),
    ).toMatchObject({
      idempotencyKey: "plan-1",
      request: {
        sourceId: "source-1",
        workflow: "compress",
        constraints: { maxCredits: 0.5 },
        options: {
          codecs: ["vp9"],
          crf: { vp9: 32 },
          frameRate: { mode: "cap", maximum: 30 },
          transform: { scale: { width: 640 } },
        },
      },
    });
  });

  it("supports a matrix with one explicit sample without making local policy decisions", () => {
    expect(
      parsePlanCreate([
        "source-1",
        "compare-quality",
        "--matrix",
        "vp9:32,40",
        "--sample",
        "frame:27",
        "--sample-duration",
        "2",
        "--metric",
        "ssim,psnr",
      ]).request,
    ).toMatchObject({
      options: {
        variants: [
          { codec: "vp9", crf: 32 },
          { codec: "vp9", crf: 40 },
        ],
        samples: { mode: "positions", positions: [{ kind: "frame", frame: 27 }] },
        durationSeconds: 2,
        objectiveMetrics: ["ssim", "psnr"],
      },
    });
    expect(
      parsePlanCreate(["source-1", "compare-quality", "--matrix", "h265:24,30"]).request.options,
    ).not.toHaveProperty("samples");
  });

  it.each([
    ["compress", "--output-dir", "out"],
    ["compress", "--no-wait"],
    ["compress", "--max-credits", "1", "--max-credits", "2"],
    ["compare-quality", "--codec", "vp9", "--crf", "32,40"],
    ["compare-quality", "--matrix", "vp9:32,40", "--duration", "2"],
    ["compare-quality", "--matrix", "vp9:32,40", "--samples", "2", "--sample", "3"],
    ["compare-quality", "--matrix", "vp9:32,,40"],
  ])("rejects invalid or retired planning arguments %j", (...args) => {
    expect(() => parsePlanCreate(["source-1", ...args])).toThrow();
  });
});

it("submits HLS defaults unchanged and shares advanced options files with optional plans", async () => {
  expect(
    parsePlanCreate(["source-1", "hls", "--no-wait", "--idempotency-key", "hls-1"], "jobs create")
      .request,
  ).toEqual({ sourceId: "source-1", workflow: "hls", options: {} });
  const directory = await mkdtemp(join(tmpdir(), "densio-hls-options-"));
  const file = join(directory, "options.json");
  await writeFile(
    file,
    JSON.stringify({
      crf: { h265: 28 },
      ladder: { mode: "custom", renditions: [{ height: 720, crf: { h265: 26 } }, { height: 360 }] },
    }),
  );
  await Promise.resolve()
    .then(() => {
      const args = ["source-1", "hls", "--options-file", file, "--destination", "densio"];
      expect(parsePlanCreate(args, "jobs create").request).toEqual(parsePlanCreate(args).request);
      expect(parsePlanCreate(args).request.options).toMatchObject({
        crf: { h265: 28 },
        ladder: { mode: "custom" },
      });
      expect(() => parsePlanCreate([...args, "--h265-crf", "30"])).toThrow(/mix/i);
      expect(() => parsePlanCreate(["source-1", "hls", "--codec", "h264"])).toThrow();
    })
    .finally(() => rm(directory, { recursive: true, force: true }));
});

it("preserves storage selection and a human video name in immutable compression intent", () => {
  expect(
    parsePlanCreate([
      "source-1",
      "compress",
      "--destination",
      "densio",
      "--name",
      "Homepage hero",
      "--visibility",
      "public",
    ]).request,
  ).toMatchObject({
    storage: { destination: { kind: "managed" }, name: "Homepage hero", visibility: "public" },
  });
  expect(
    parsePlanCreate(["source-1", "compress", "--destination", "website"]).request,
  ).toMatchObject({ storage: { destination: { kind: "connection", connectionId: "website" } } });
});

it.each(["jobs create", "plans create"] as const)(
  "supports standalone trimming through %s",
  (command) => {
    expect(
      parsePlanCreate(
        [
          "source-1",
          "trim",
          "--codec",
          "h265",
          "--trim-start",
          "frame:3",
          "--trim-end",
          "00:00:01.250",
        ],
        command,
      ).request,
    ).toEqual({
      sourceId: "source-1",
      workflow: "trim",
      options: {
        output: { codec: "h265" },
        trim: {
          start: { kind: "frame", frame: 3 },
          end: { kind: "timecode", timecode: "00:00:01.250" },
        },
      },
    });
  },
);
it("retains a compression range and rejects trim flags that would be silently ignored", () => {
  expect(parsePlanCreate(["s", "compress", "--trim-start", "0.125"]).request).toMatchObject({
    options: { trim: { start: { kind: "seconds", seconds: 0.125 } } },
  });
  expect(() => parsePlanCreate(["s", "compress", "--trim-end", "frame:9"])).toThrow();
  expect(() =>
    parsePlanCreate(["s", "trim", "--codec", "vp9,h265", "--trim-start", "0"]),
  ).toThrow();
  expect(() =>
    parsePlanCreate(["s", "trim", "--codec", "vp9", "--h265-crf", "30", "--trim-start", "0"]),
  ).toThrow();
});

it.each(["frame:", "frame: ", "frame:0x10", "frame:1e2", "frame:1.5"])(
  "rejects malformed frame position %s",
  (position) => {
    expect(() => parsePlanCreate(["s", "compress", "--trim-start", position])).toThrow();
  },
);
