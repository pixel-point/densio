import type { StorageConnectionConfig } from "@densio/shared";
import { assertStorageEndpoint } from "../objects/endpoint-policy.ts";
import { storageFailure } from "../storage-errors.ts";

export interface ConnectionServiceConfig {
  readonly now: () => number;
  readonly credentialKeys: Readonly<Record<string, string>>;
  readonly activeCredentialKey: string;
  readonly allowedOrigins?: readonly string[];
}
export const validateConnectionConfig = (
  config: StorageConnectionConfig,
  allowedOrigins: readonly string[] = [],
) => {
  [config.location, ...(config.staging ? [config.staging] : [])].forEach((location) => {
    if (location.prefix !== "" && !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(location.prefix))
      throw storageFailure("INVALID_REQUEST", "Use a relative prefix with simple path segments.");
    assertEndpoint(location.endpoint, false, allowedOrigins);
  });
  if (config.publicBaseUrl) assertEndpoint(config.publicBaseUrl, true, allowedOrigins);
  if (config.stagingPublicBaseUrl)
    assertEndpoint(config.stagingPublicBaseUrl, true, allowedOrigins);
  if (config.visibility === "public" && !config.publicBaseUrl)
    throw storageFailure("STORAGE_PUBLIC_DELIVERY_REQUIRED");
  if (
    config.provider === "r2" &&
    config.visibility === "public" &&
    config.staging?.bucket === config.location.bucket &&
    config.staging.endpoint === config.location.endpoint
  )
    throw storageFailure(
      "STORAGE_PRIVATE_STAGING_REQUIRED",
      "Public R2 output requires a separate private staging bucket.",
    );
};
const assertEndpoint = (url: string, allowPath: boolean, allowedOrigins: readonly string[]) => {
  try {
    assertStorageEndpoint(url, allowPath, allowedOrigins);
  } catch {
    throw storageFailure("STORAGE_ENDPOINT_REJECTED");
  }
};
