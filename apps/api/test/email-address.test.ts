import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { InvalidEmailAddress, parseEmailAddress } from "../src/auth/email-address.ts";

describe("parseEmailAddress", () => {
  it("trims and lowercases a valid email address", async () => {
    const email = await Effect.runPromise(parseEmailAddress("  Alice.Example+video@Example.COM  "));

    expect(email).toBe("alice.example+video@example.com");
  });

  it.each([
    "",
    "person",
    "@example.com",
    "person@",
    "person @example.com",
    "person@example",
    ".person@example.com",
    "person.@example.com",
    "person..alias@example.com",
    `${"a".repeat(65)}@example.com`,
    `${"a".repeat(245)}@example.com`,
    42,
    null,
  ])("rejects invalid input %j without reflecting it in the error", async (input) => {
    const error = await Effect.runPromise(Effect.flip(parseEmailAddress(input)));

    expect(error).toBeInstanceOf(InvalidEmailAddress);
    expect(error).toMatchObject({
      _tag: "InvalidEmailAddress",
      message: "Enter a valid email address.",
    });
    if (String(input).length > 0) {
      expect(JSON.stringify(error)).not.toContain(String(input));
    }
  });
});
