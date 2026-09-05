import { expect, test } from "vitest";
import {
  filenameStem,
  managedObjectKey,
  variantFilename,
} from "../src/storage/managed/object-key.ts";
import {
  sealStorageCredentials,
  openStorageCredentials,
} from "../src/storage/connections/credentials.ts";
import {
  assertStorageEndpoint,
  isPublicAddress,
  resolveStorageAddress,
} from "../src/storage/objects/endpoint-policy.ts";

test("named codec files live directly beneath a video and reject path injection", () => {
  expect(filenameStem(undefined, "Homepage Hero.mov")).toBe("homepage-hero");
  expect(filenameStem("Café & Landing", "original.mov")).toBe("cafe-landing");
  expect(filenameStem("影片", "original.mov")).toBe("video");
  expect(filenameStem("x".repeat(100), "original.mov")).toHaveLength(80);
  expect(variantFilename("homepage-hero", "h265")).toBe("homepage-hero-h265.mp4");
  expect(managedObjectKey("org-one", "video-one", "homepage-hero-vp9.webm")).toBe(
    "orgs/org-one/videos/video-one/homepage-hero-vp9.webm",
  );
  expect(() => managedObjectKey("../foreign", "video-one", "clip-vp9.webm")).toThrow();
  expect(() => managedObjectKey("org-one", "video-one", "a%2fb.webm")).toThrow();
});

test("storage credentials are authenticated and bound to an organization, connection and version", () => {
  const binding = { organizationId: "org-one", connectionId: "connection-one", version: 1 };
  const secret = { accessKeyId: "fixture-access", secretAccessKey: "fixture-secret" };
  const key = "ab".repeat(32);
  const ciphertext = sealStorageCredentials(key, binding, secret);
  expect(ciphertext).not.toContain(secret.secretAccessKey);
  expect(openStorageCredentials(key, binding, ciphertext)).toEqual(secret);
  expect(() =>
    openStorageCredentials(key, { ...binding, organizationId: "org-two" }, ciphertext),
  ).toThrow();
  expect(() => openStorageCredentials(key, { ...binding, version: 2 }, ciphertext)).toThrow();
  expect(() => openStorageCredentials("cd".repeat(32), binding, ciphertext)).toThrow();
});

test("hosted endpoints prohibit local networks, credentials, aliases and non-HTTPS destinations", () => {
  for (const url of [
    "http://example.com",
    "https://localhost",
    "https://127.0.0.1",
    "https://[::1]",
    "https://169.254.169.254",
    "https://example.com:444",
    "https://user:pass@example.com",
    "https://example.com/?token=x",
    "https://example.com/#x",
  ]) {
    expect(() => assertStorageEndpoint(url)).toThrow();
  }
  expect(assertStorageEndpoint("https://s3.eu-west-1.amazonaws.com").hostname).toBe(
    "s3.eu-west-1.amazonaws.com",
  );
  for (const address of [
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "::ffff:127.0.0.1",
    "fe80::1",
    "fc00::1",
    "192.0.2.1",
  ])
    expect(isPublicAddress(address)).toBe(false);
  expect(isPublicAddress("1.1.1.1")).toBe(true);
});

test("a mixed DNS response is rejected instead of selecting only its safe address", async () => {
  await expect(
    resolveStorageAddress("storage.example.com", async () => [
      { address: "1.1.1.1", family: 4 },
      { address: "::1", family: 6 },
    ]),
  ).rejects.toThrow();
  await expect(
    resolveStorageAddress("storage.example.com", async () => [{ address: "1.1.1.1", family: 4 }]),
  ).resolves.toEqual({ address: "1.1.1.1", family: 4 });
});
