import { inspect } from "node:util";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  InvalidOpaqueToken,
  createOpaqueToken,
  formatOpaqueToken,
  hashTokenSecret,
  parseOpaqueToken,
  verifyTokenSecret,
} from "../src/auth/opaque-token.ts";

describe("opaque tokens", () => {
  it("creates unique tokens from cryptographically sized random values", () => {
    const tokens = Array.from({ length: 128 }, createOpaqueToken);

    expect(new Set(tokens.map(formatOpaqueToken))).toHaveLength(tokens.length);
    tokens.forEach((token) => {
      expect(token.publicId).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(token.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });
  });

  it("hashes secrets one way and verifies them", () => {
    const token = createOpaqueToken();
    const hash = hashTokenSecret(token.secret);

    expect(hash).toMatch(/^sha256\.[A-Za-z0-9_-]{43}$/);
    expect(hash).not.toContain(token.secret);
    expect(hashTokenSecret(token.secret)).toBe(hash);
    expect(verifyTokenSecret(token.secret, hash)).toBe(true);
    expect(verifyTokenSecret(`${token.secret}x`, hash)).toBe(false);
    expect(verifyTokenSecret(token.secret, "not-a-token-hash")).toBe(false);
  });

  it("parses the public id and secret without exposing the secret to logs", async () => {
    const created = createOpaqueToken();
    const rawToken = formatOpaqueToken(created);
    const parsed = await Effect.runPromise(parseOpaqueToken(rawToken));

    expect(parsed.publicId).toBe(created.publicId);
    expect(parsed.secret).toBe(created.secret);
    expect(inspect(parsed)).not.toContain(created.secret);
    expect(JSON.stringify(parsed)).not.toContain(created.secret);
    expect(String(parsed)).not.toContain(created.secret);
  });

  it.each([
    "",
    "missing-separator",
    ".secret",
    "public.",
    "public.secret.extra",
    "public id.secret",
    123,
    null,
  ])("rejects malformed token %j without reflecting its value", async (input) => {
    const error = await Effect.runPromise(Effect.flip(parseOpaqueToken(input)));

    expect(error).toBeInstanceOf(InvalidOpaqueToken);
    expect(error).toMatchObject({
      _tag: "InvalidOpaqueToken",
      message: "The authentication token is invalid.",
    });
    if (String(input).length > 0) {
      expect(JSON.stringify(error)).not.toContain(String(input));
    }
  });
});
