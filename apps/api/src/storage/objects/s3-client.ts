import { S3Client } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { StorageCredentials, StorageLocation } from "@densio/shared";
import { assertStorageEndpoint, storageLookup } from "./endpoint-policy.ts";
import { VideoStorageError } from "../storage-errors.ts";

export const makeStorageS3Client = (
  location: StorageLocation,
  credentials: StorageCredentials,
  allowedOrigins: readonly string[],
) => {
  const endpoint = assertStorageEndpoint(location.endpoint, false, allowedOrigins);
  return new S3Client({
    endpoint: endpoint.href,
    region: location.region,
    credentials,
    forcePathStyle: location.pathStyle,
    maxAttempts: 1,
    followRegionRedirects: false,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: new NodeHttpHandler({
      connectionTimeout: 10_000,
      requestTimeout: 120_000,
      throwOnRequestTimeout: true,
      httpsAgent: {
        keepAlive: false,
        maxSockets: 4,
        ...(allowedOrigins.includes(endpoint.origin) ? {} : { lookup: storageLookup }),
      },
      httpAgent: { keepAlive: false, maxSockets: 4 },
    }),
  });
};

export const providerFailure = (error: unknown): never => {
  const status =
    error !== null &&
    typeof error === "object" &&
    "$metadata" in error &&
    error.$metadata !== null &&
    typeof error.$metadata === "object" &&
    "httpStatusCode" in error.$metadata
      ? error.$metadata.httpStatusCode
      : undefined;
  throw new VideoStorageError({
    code:
      status === 403 || status === 401
        ? "STORAGE_PERMISSION_DENIED"
        : "STORAGE_PROVIDER_UNAVAILABLE",
    detail: "The storage operation could not be completed.",
    operation: "S3.request",
    cause: error,
  });
};
export const missingObject = (error: unknown) =>
  error instanceof Error &&
  ["NotFound", "NoSuchKey", "NoSuchUpload", "NoSuchVersion"].includes(error.name);
export const objectRequestOptions = (signal?: AbortSignal) => ({
  abortSignal:
    signal === undefined
      ? AbortSignal.timeout(120_000)
      : AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
});
