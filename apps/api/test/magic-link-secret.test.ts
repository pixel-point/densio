import { expect, it } from "vitest";

import {
  InvalidMagicLinkSecret,
  makeMagicLinkOpener,
  makeMagicLinkSealer,
} from "../src/auth/magic-link-secret.ts";

const key = "0123456789abcdef".repeat(4);
const otherKey = "fedcba9876543210".repeat(4);
const context = {
  challengeId: "challenge-1",
  emailId: "email-1",
  recipient: "agent@example.com",
};
const url = "https://media.example/v1/auth/confirm?token=public.secret";

it("round trips a magic link without revealing it and uses a fresh nonce", () => {
  const seal = makeMagicLinkSealer(key);
  const open = makeMagicLinkOpener(key);
  const first = seal(url, context);
  const second = seal(url, context);

  expect(open(first, context)).toBe(url);
  expect(open(second, context)).toBe(url);
  expect(first).not.toBe(second);
  expect(first).not.toContain("secret");
  expect(first).not.toContain("https://");
});

it("fails closed for a wrong key, changed row context, tampering, and malformed envelopes", () => {
  const sealed = makeMagicLinkSealer(key)(url, context);
  const open = makeMagicLinkOpener(key);
  const changedContext = { ...context, recipient: "attacker@example.com" };
  const parts = sealed.split(".");
  const authenticationTag = parts[2] ?? "";
  parts[2] = `${authenticationTag.startsWith("A") ? "B" : "A"}${authenticationTag.slice(1)}`;
  const tampered = parts.join(".");

  expect(() => makeMagicLinkOpener(otherKey)(sealed, context)).toThrow(InvalidMagicLinkSecret);
  expect(() => open(sealed, changedContext)).toThrow(InvalidMagicLinkSecret);
  expect(() => open(tampered, context)).toThrow(InvalidMagicLinkSecret);
  expect(() => open("not-an-envelope", context)).toThrow(InvalidMagicLinkSecret);
});

it("rejects malformed encryption keys before processing any rows", () => {
  expect(() => makeMagicLinkSealer("too-short")).toThrow(InvalidMagicLinkSecret);
  expect(() => makeMagicLinkOpener("z".repeat(64))).toThrow(InvalidMagicLinkSecret);
});
