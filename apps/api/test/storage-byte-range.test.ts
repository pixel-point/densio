import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { RangeNotSatisfiable, parseSingleRange } from "../src/storage/byte-range.ts";

describe("single byte ranges", () => {
  it("returns no range when the request has no Range header", async () => {
    await expect(Effect.runPromise(parseSingleRange(undefined, 10))).resolves.toBeUndefined();
  });

  it.each([
    ["bytes=0-4", { contentRange: "bytes 0-4/10", end: 4, length: 5, start: 0 }],
    ["bytes=5-", { contentRange: "bytes 5-9/10", end: 9, length: 5, start: 5 }],
    ["bytes=-3", { contentRange: "bytes 7-9/10", end: 9, length: 3, start: 7 }],
    ["bytes=-20", { contentRange: "bytes 0-9/10", end: 9, length: 10, start: 0 }],
    ["bytes=2-99", { contentRange: "bytes 2-9/10", end: 9, length: 8, start: 2 }],
  ])("normalizes %s for a 206 response", async (header, expected) => {
    await expect(Effect.runPromise(parseSingleRange(header, 10))).resolves.toEqual(expected);
  });

  it.each([
    ["bytes=0-0", 0],
    ["items=0-1", 10],
    ["bytes=0-1,4-5", 10],
    ["bytes=5-4", 10],
    ["bytes=10-", 10],
    ["bytes=-0", 10],
    ["bytes=-", 10],
    ["bytes=a-b", 10],
    ["bytes=1.5-2", 10],
    ["", 10],
  ])("returns a typed 416 failure for invalid range %j", async (header, size) => {
    const error = await Effect.runPromise(Effect.flip(parseSingleRange(header, size)));

    expect(error).toBeInstanceOf(RangeNotSatisfiable);
    expect(error).toMatchObject({
      contentRange: `bytes */${size}`,
      message: "The requested byte range is not satisfiable.",
      status: 416,
    });
  });
});
