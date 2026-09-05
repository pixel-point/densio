import { Effect } from "effect";
import { expect, it } from "vitest";
import { decodeMediaProbe } from "../src/media/inspection/media-probe.ts";
import { normalizeSourceInspection } from "../src/sources/source-inspection.ts";
import { matchesPlannedInspection } from "../src/sources/source-inspection-compatibility.ts";

it("compares legacy snapshots using recorded fields while fencing changed recorded metadata", async () => {
  const legacy = await inspect({});
  const current = await inspect({
    pix_fmt: "yuv420p10le",
    field_order: "progressive",
    color_transfer: "bt709",
  });
  expect(matchesPlannedInspection(legacy, current)).toBe(true);
  expect(matchesPlannedInspection(current, legacy)).toBe(false);
  expect(
    matchesPlannedInspection(
      current,
      await inspect({
        pix_fmt: "yuv420p10le",
        field_order: "progressive",
        color_transfer: "smpte2084",
      }),
    ),
  ).toBe(false);
  expect(matchesPlannedInspection(legacy, { ...current, durationSeconds: 11 })).toBe(false);
});

const inspect = (extra: object) =>
  Effect.runPromise(
    Effect.flatMap(
      decodeMediaProbe(
        JSON.stringify({
          format: { duration: "10" },
          streams: [
            {
              index: 0,
              codec_type: "video",
              codec_name: "hevc",
              width: 640,
              height: 360,
              avg_frame_rate: "30/1",
              ...extra,
            },
            {
              index: 1,
              codec_type: "audio",
              codec_name: "aac",
              ...(Object.keys(extra).length
                ? { channels: 2, sample_rate: "48000", start_time: "0" }
                : {}),
            },
          ],
        }),
      ),
      normalizeSourceInspection,
    ),
  );
