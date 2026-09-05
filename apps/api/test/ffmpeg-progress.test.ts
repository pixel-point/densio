import { expect, it } from "vitest";

import { makeFfmpegProgressParser } from "../src/media/process/ffmpeg-progress.ts";

it("parses incremental LF and CRLF records while excluding protocol text", () => {
  const records: Array<unknown> = [];
  const parser = makeFfmpegProgressParser((record) => records.push(record));

  parser.push("frame=12\r\nout_time_");
  parser.push("us=2500000\nspeed=1.25x\nprogress=continue\n");
  parser.push("note=keep this diagnostic\r\n");
  parser.push("frame=bad\nout_time_ms=3000000\nspeed=N/A\nprogress=end\n");

  expect(parser.finish()).toBe("note=keep this diagnostic\n");
  expect(records).toEqual([
    {
      frame: 12,
      outTimeSeconds: 2.5,
      progress: "continue",
      speed: 1.25,
    },
    { outTimeSeconds: 3, progress: "end" },
  ]);
});

it("flushes a final complete protocol record split at the last chunk", () => {
  const records: Array<unknown> = [];
  const parser = makeFfmpegProgressParser((record) => records.push(record));

  parser.push("frame=4\nout_time_us=1000000\nprogress=en");
  parser.push("d");

  expect(parser.finish()).toBe("");
  expect(records).toEqual([{ frame: 4, outTimeSeconds: 1, progress: "end" }]);
});
