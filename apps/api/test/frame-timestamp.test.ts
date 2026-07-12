import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decodeFrameTimestamp } from "../src/media/inspection/frame-timestamp.ts";

describe("frame timestamp decoding", () => {
  it("resolves an exact zero-based frame from variable-frame-rate timestamps", async () => {
    const output = JSON.stringify({
      frames: [
        { best_effort_timestamp_time: "0.000000" },
        { best_effort_timestamp_time: "0.041708" },
        { best_effort_timestamp_time: "0.125125" },
      ],
    });

    await expect(Effect.runPromise(decodeFrameTimestamp(output, 2))).resolves.toBe(0.125125);
  });

  it("falls back to the frame PTS when a best-effort timestamp is absent", async () => {
    const output = JSON.stringify({ frames: [{ pts_time: "4.250000" }] });

    await expect(Effect.runPromise(decodeFrameTimestamp(output, 0))).resolves.toBe(4.25);
  });

  it.each([
    ["not-json", 0, "invalid-frame-output"],
    [JSON.stringify({ frames: [] }), 0, "frame-out-of-range"],
    [
      JSON.stringify({ frames: [{ best_effort_timestamp_time: "N/A" }] }),
      0,
      "invalid-frame-output",
    ],
    [JSON.stringify({ frames: [] }), -1, "invalid-frame-index"],
    [JSON.stringify({ frames: [] }), 1.5, "invalid-frame-index"],
  ] as const)("rejects invalid frame data", async (output, index, reason) => {
    const error = await Effect.runPromise(Effect.flip(decodeFrameTimestamp(output, index)));

    expect(error).toMatchObject({ _tag: "MediaInspectionError", reason });
  });
});
