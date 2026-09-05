import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { HttpUrlSchema, IsoTimestampSchema } from "../src/common-contracts.ts";

describe("semantic transport primitives", () => {
  it.each(["https://[", "https://", "http://host:99999", "ftp://example.com"])(
    "rejects an invalid HTTP URL: %s",
    (value) => expect(() => Schema.decodeUnknownSync(HttpUrlSchema)(value)).toThrow(),
  );
  it.each(["https://example.com/path?q=a%20b", "http://127.0.0.1:3000/", "https://[::1]/"])(
    "preserves valid HTTP URLs: %s",
    (value) => expect(Schema.decodeUnknownSync(HttpUrlSchema)(value)).toBe(value),
  );
  it.each([
    "2026-99-99T99:99:99Z",
    "2026-02-29T12:00:00Z",
    "2026-04-31T12:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T12:00:60Z",
  ])("rejects nonexistent UTC timestamps: %s", (value) =>
    expect(() => Schema.decodeUnknownSync(IsoTimestampSchema)(value)).toThrow(),
  );
  it.each(["2024-02-29T12:00:00Z", "2026-01-01T00:00:00.123456789Z", "0099-01-01T00:00:00Z"])(
    "preserves supported timestamp precision: %s",
    (value) => expect(Schema.decodeUnknownSync(IsoTimestampSchema)(value)).toBe(value),
  );
});
