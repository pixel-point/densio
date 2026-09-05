import { StorageCredentialsSchema } from "@densio/shared";
import { Option, Schema } from "effect";
import { canonicalDigest } from "../idempotency/canonical-digest.ts";
import { assertStorageEndpoint } from "./objects/endpoint-policy.ts";

const Bucket = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/));
const ManagedTarget = Schema.Struct({
  name: Schema.NonEmptyString,
  endpoint: Schema.NonEmptyString,
  publicBucket: Bucket,
  privateBucket: Bucket,
  stagingBucket: Bucket,
  publicOrigin: Schema.NonEmptyString,
  credentials: StorageCredentialsSchema,
  zoneId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
  purgeToken: Schema.NonEmptyString,
});
const StorageConfig = Schema.Struct({
  credentialKeys: Schema.Record(
    Schema.String,
    Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]{64}$/)),
  ),
  activeCredentialKey: Schema.String,
  activeManagedTarget: Schema.optionalKey(Schema.NonEmptyString),
  managedTargets: Schema.Array(ManagedTarget),
});
export type StorageRuntimeConfig = typeof StorageConfig.Type;
export type ManagedStorageTarget = typeof ManagedTarget.Type;

export const loadStorageConfig = (input: string | undefined): StorageRuntimeConfig => {
  if (!input) return { credentialKeys: {}, activeCredentialKey: "", managedTargets: [] };
  const result = Schema.decodeUnknownOption(Schema.fromJsonString(StorageConfig))(input);
  if (Option.isNone(result)) throw new Error("Invalid storage configuration");
  const config = result.value;
  if (
    (config.activeCredentialKey !== "" && !config.credentialKeys[config.activeCredentialKey]) ||
    (config.activeManagedTarget &&
      !config.managedTargets.some((target) => target.name === config.activeManagedTarget)) ||
    new Set(config.managedTargets.map((target) => target.name)).size !==
      config.managedTargets.length
  )
    throw new Error("Invalid storage configuration");
  config.managedTargets.forEach(validateManagedTarget);
  return config;
};
const validateManagedTarget = (target: ManagedStorageTarget) => {
  if (new Set([target.publicBucket, target.privateBucket, target.stagingBucket]).size !== 3)
    throw new Error("Invalid storage configuration");
  try {
    assertStorageEndpoint(target.endpoint);
    assertStorageEndpoint(target.publicOrigin);
    if (!new URL(target.endpoint).hostname.endsWith(".r2.cloudflarestorage.com")) throw new Error();
  } catch {
    throw new Error("Invalid storage configuration");
  }
};
export const managedTargetId = (target: ManagedStorageTarget) =>
  `managed:${canonicalDigest({
    endpoint: new URL(target.endpoint).origin,
    publicBucket: target.publicBucket,
    privateBucket: target.privateBucket,
    stagingBucket: target.stagingBucket,
    publicOrigin: new URL(target.publicOrigin).origin,
    zoneId: target.zoneId,
  })}`;
