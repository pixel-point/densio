import { describe, expect, it } from "vitest";

import {
  buildCompressionPlan,
  buildDefaultCompressionPlans,
} from "../src/media/compression-plan.ts";
import { expectCommandSequence } from "./expect-command.ts";

const source = { width: 1920, height: 1080 } as const;

describe("default compression plans", () => {
  it("builds the article VP9 command with constrained-quality bitrate mode", () => {
    const [plan] = buildDefaultCompressionPlans({
      inputPath: "/tmp/input.mp4",
      outputPaths: { vp9: "/tmp/output.webm", h265: "/tmp/output.mp4" },
      source,
      audioAnalysis: "absent",
    });

    expect(plan?.argv).toEqual([
      "-hide_banner",
      "-nostdin",
      "-y",
      "-i",
      "/tmp/input.mp4",
      "-map",
      "0:v:0",
      "-c:v",
      "libvpx-vp9",
      "-b:v",
      "0",
      "-crf",
      "42",
      "-deadline",
      "best",
      "-pix_fmt",
      "yuv420p",
      "-an",
      "/tmp/output.webm",
    ]);
  });

  it("builds the article H.265 command with browser compatibility flags", () => {
    const plans = buildDefaultCompressionPlans({
      inputPath: "/tmp/input.mp4",
      outputPaths: { vp9: "/tmp/output.webm", h265: "/tmp/output.mp4" },
      source,
      audioAnalysis: "silent",
    });

    expect(plans[1]?.argv).toEqual([
      "-hide_banner",
      "-nostdin",
      "-y",
      "-i",
      "/tmp/input.mp4",
      "-map",
      "0:v:0",
      "-c:v",
      "libx265",
      "-crf",
      "30",
      "-preset",
      "veryslow",
      "-tag:v",
      "hvc1",
      "-movflags",
      "faststart",
      "-pix_fmt",
      "yuv420p",
      "-an",
      "/tmp/output.mp4",
    ]);
  });
});

describe("codec-specific compression plans", () => {
  it("builds opt-in SVT-AV1 WebM output", () => {
    const plan = buildCompressionPlan({
      codec: "av1",
      crf: 41,
      inputPath: "/tmp/input.mp4",
      outputPath: "/tmp/output.webm",
      source,
      audio: "remove",
    });

    expectCommandSequence(
      plan.argv,
      "-c:v",
      "libsvtav1",
      "-b:v",
      "0",
      "-crf",
      "41",
      "-preset",
      "6",
    );
  });

  it("uses codec-specific custom CRFs in default output plans", () => {
    const plans = buildDefaultCompressionPlans({
      inputPath: "input.mp4",
      outputPaths: { vp9: "output.webm", h265: "output.mp4" },
      source,
      audio: "remove",
      crf: { vp9: 51, h265: 27 },
    });

    expect(plans.map(({ argv }) => argv.at(argv.indexOf("-crf") + 1))).toEqual(["51", "27"]);
  });

  it.each([
    ["vp9", -1],
    ["vp9", 64],
    ["h265", 52],
    ["av1", Number.NaN],
    ["vp9", "40;touch /tmp/pwned"],
  ] as const)("rejects an invalid %s CRF", (codec, crf) => {
    expect(() =>
      buildCompressionPlan({
        codec,
        crf: crf as number,
        inputPath: "input.mp4",
        outputPath: "output.webm",
        source,
        audio: "remove",
      }),
    ).toThrow(/CRF/);
  });

  it("rejects prototype-shaped runtime codec values", () => {
    expect(() =>
      buildCompressionPlan({
        codec: "toString" as "vp9",
        inputPath: "input.mp4",
        outputPath: "output.webm",
        source,
        audio: "remove",
      }),
    ).toThrow(/codec/i);
  });
});

describe("compression audio decisions", () => {
  it("keeps audible audio in automatic mode with a container-compatible codec", () => {
    const plan = buildCompressionPlan({
      codec: "vp9",
      inputPath: "input.mp4",
      outputPath: "output.webm",
      source,
      audio: "auto",
      audioAnalysis: "audible",
    });

    expectCommandSequence(plan.argv, "-map", "0:a:0");
    expectCommandSequence(plan.argv, "-c:a", "libopus");
    expect(plan.argv).not.toContain("-an");
  });

  it("removes silent audio in automatic mode", () => {
    const plan = buildCompressionPlan({
      codec: "h265",
      inputPath: "input.mp4",
      outputPath: "output.mp4",
      source,
      audio: "auto",
      audioAnalysis: "silent",
    });

    expect(plan.argv).toContain("-an");
  });

  it("honors explicit keep and remove decisions", () => {
    const kept = buildCompressionPlan({
      codec: "h265",
      inputPath: "input.mp4",
      outputPath: "output.mp4",
      source,
      audio: "keep",
      audioAnalysis: "silent",
    });
    const removed = buildCompressionPlan({
      codec: "vp9",
      inputPath: "input.mp4",
      outputPath: "output.webm",
      source,
      audio: "remove",
      audioAnalysis: "audible",
    });

    expectCommandSequence(kept.argv, "-map", "0:a:0");
    expectCommandSequence(kept.argv, "-c:a", "aac");
    expect(removed.argv).toContain("-an");
  });

  it("requires completed analysis for automatic audio", () => {
    expect(() =>
      buildCompressionPlan({
        codec: "vp9",
        inputPath: "input.mp4",
        outputPath: "output.webm",
        source,
        audio: "auto",
      }),
    ).toThrow(/audio analysis/i);
  });
});

describe("compression command safety", () => {
  it("keeps paths as argv entries and safely quotes the diagnostic command", () => {
    const plan = buildCompressionPlan({
      executable: "/opt/ffmpeg/bin/ffmpeg",
      codec: "vp9",
      inputPath: "/tmp/input; touch hacked.mp4",
      outputPath: "/tmp/output's video.webm",
      source,
      audio: "remove",
    });

    expect(plan.executable).toBe("/opt/ffmpeg/bin/ffmpeg");
    expect(plan.argv).toContain("/tmp/input; touch hacked.mp4");
    expect(plan.displayCommand).toContain("'/tmp/input; touch hacked.mp4'");
    expect(plan.displayCommand).toContain("'/tmp/output'\"'\"'s video.webm'");
  });

  it("rejects control characters in command paths", () => {
    expect(() =>
      buildCompressionPlan({
        codec: "vp9",
        inputPath: "input.mp4\n-injected",
        outputPath: "output.webm",
        source,
        audio: "remove",
      }),
    ).toThrow(/path/i);
  });
});
