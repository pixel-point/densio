import { expect, it } from "vitest";

import { makeRequestIpHasher } from "../src/http/request-ip.ts";

it("hashes the socket address when proxy headers are not trusted", () => {
  const hash = makeRequestIpHasher("test-secret", false);
  const request = new Request("https://media.example", {
    headers: { "x-forwarded-for": "203.0.113.9" },
  });

  expect(hash(request, "192.0.2.4")).toBe(hash(new Request("https://media.example"), "192.0.2.4"));
  expect(hash(request, "192.0.2.4")).not.toBe(hash(request, "203.0.113.9"));
});

it("uses only the first valid forwarded address behind a trusted proxy", () => {
  const hash = makeRequestIpHasher("test-secret", true);
  const forwarded = new Request("https://media.example", {
    headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
  });

  expect(hash(forwarded, "192.0.2.4")).toBe(
    hash(
      new Request("https://media.example", { headers: { "x-forwarded-for": "203.0.113.9" } }),
      "10.0.0.2",
    ),
  );
  expect(hash(forwarded, "192.0.2.4")).toMatch(/^[a-f0-9]{64}$/);
});

it("falls back safely when the forwarded address is malformed", () => {
  const hash = makeRequestIpHasher("test-secret", true);
  const malformed = new Request("https://media.example", {
    headers: { "x-forwarded-for": "not-an-ip" },
  });

  expect(hash(malformed, "192.0.2.4")).toBe(
    hash(new Request("https://media.example"), "192.0.2.4"),
  );
});
