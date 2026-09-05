import { expect, test } from "vitest";
import { loadStorageConfig, managedTargetId } from "../src/storage/storage-config.ts";

test("storage remains unconfigured without secrets and rejects partial or unsafe configurations", () => {
  expect(loadStorageConfig(undefined)).toEqual({
    credentialKeys: {},
    activeCredentialKey: "",
    managedTargets: [],
  });
  expect(() => loadStorageConfig('{"credentialKeys":{"active":"secret-value"}}')).toThrow(
    "Invalid storage configuration",
  );
  expect(() =>
    loadStorageConfig(
      JSON.stringify({
        credentialKeys: {},
        activeCredentialKey: "",
        managedTargets: [target({ endpoint: "http://127.0.0.1" })],
      }),
    ),
  ).toThrow("Invalid storage configuration");
});

test("physical target identities survive credential rotation but change with physical locations", () => {
  expect(managedTargetId(target())).toBe(
    managedTargetId(
      target({ credentials: { accessKeyId: "rotated", secretAccessKey: "rotated" } }),
    ),
  );
  expect(managedTargetId(target())).not.toBe(
    managedTargetId(target({ privateBucket: "other-private" })),
  );
  const configured = loadStorageConfig(
    JSON.stringify({
      credentialKeys: { primary: "ab".repeat(32) },
      activeCredentialKey: "primary",
      activeManagedTarget: "production",
      managedTargets: [target()],
    }),
  );
  expect(configured.activeManagedTarget).toBe("production");
});

const target = (overrides = {}) => ({
  name: "production",
  endpoint: "https://0123456789abcdef.r2.cloudflarestorage.com",
  publicBucket: "densio-prod-media-public",
  privateBucket: "densio-prod-media-private",
  stagingBucket: "densio-prod-media-staging",
  publicOrigin: "https://media.example.test",
  zoneId: "a".repeat(32),
  purgeToken: "fixture",
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
  ...overrides,
});
