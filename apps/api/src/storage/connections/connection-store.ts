import type { StorageCredentials, StorageLocation } from "@densio/shared";
import type { IncomingMessage } from "node:http";
import type { storageConnections } from "../../database/video-storage-schema.ts";
import type { ObjectStore } from "../objects/object-store.ts";
import { makeS3ObjectStore } from "../objects/s3-object-store.ts";
import { readPublicObject } from "../objects/public-delivery.ts";
import { storageFailure } from "../storage-errors.ts";
import type { ConnectionServiceConfig } from "./connection-config.ts";
import { decodeConnectionConfig } from "./connection-catalog.ts";
import { openStorageCredentials } from "./credentials.ts";
import { publicObjectUrl } from "../../videos/video-catalog.ts";

export interface ConnectionProviderConfig extends ConnectionServiceConfig {
  readonly storeFactory?: (
    location: StorageLocation,
    credentials: StorageCredentials,
  ) => ObjectStore;
  readonly verifyAccess?: (
    url: string,
    publiclyReadable: boolean,
    bytes: number,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly writerIdentity?: string;
  readonly isWriterAlive?: (pid: number, identity: string) => boolean;
}
export const openConnectionStores = (
  row: typeof storageConnections.$inferSelect,
  config: ConnectionProviderConfig,
  candidate?: { ciphertext: string; version: number; keyVersion: string },
) => {
  const keyVersion = candidate ? candidate.keyVersion : row.encryptionKeyVersion;
  const key = config.credentialKeys[keyVersion];
  if (!key || (!candidate && !row.credentialsCiphertext))
    throw storageFailure("STORAGE_CONNECTION_UNAVAILABLE");
  const credentials = openStorageCredentials(
    key,
    {
      organizationId: row.organizationId,
      connectionId: row.id,
      version: candidate?.version ?? row.credentialVersion,
    },
    candidate?.ciphertext ?? row.credentialsCiphertext ?? "",
  );
  const definition = decodeConnectionConfig(row.configJson);
  const create =
    config.storeFactory ??
    ((location, secret) =>
      makeS3ObjectStore(location, secret, { allowedOrigins: config.allowedOrigins ?? [] }));
  return {
    definition,
    output: create(definition.location, credentials),
    staging: definition.staging
      ? create(definition.staging, credentials.staging ?? credentials)
      : undefined,
  };
};
export const verifyConnectionAccess = async (
  url: string,
  publicRead: boolean,
  bytes: number,
  config: ConnectionProviderConfig,
  signal?: AbortSignal,
) => {
  if (config.verifyAccess) return config.verifyAccess(url, publicRead, bytes, signal);
  const response = await readPublicObject(url, "GET", "bytes=0-0", config.allowedOrigins, signal);
  const valid = await Promise.resolve()
    .then(() =>
      publicRead
        ? response.statusCode === 206 && response.headers["content-range"] === `bytes 0-0/${bytes}`
        : deniesAnonymousRead(response),
    )
    .finally(() => response.destroy());
  if (!valid)
    throw storageFailure(
      publicRead ? "STORAGE_PUBLIC_DELIVERY_REQUIRED" : "STORAGE_PRIVATE_STAGING_REQUIRED",
    );
};
const deniesAnonymousRead = async (response: IncomingMessage) => {
  if (response.statusCode === 403 || response.statusCode === 404) return true;
  if (response.statusCode !== 400) return false;
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > 1024) return false;
    chunks.push(Buffer.from(chunk));
  }
  // R2 reports missing authorization as this S3 error with HTTP 400.
  const body = Buffer.concat(chunks).toString("utf8");
  return (
    body.includes("<Code>InvalidArgument</Code>") &&
    body.includes("<Message>Authorization</Message>")
  );
};
export const anonymousStorageUrl = (location: StorageLocation, key: string) => {
  const endpoint = new URL(location.endpoint);
  if (location.pathStyle) return publicObjectUrl(`${endpoint.origin}/${location.bucket}`, key);
  endpoint.hostname = `${location.bucket}.${endpoint.hostname}`;
  return publicObjectUrl(endpoint.origin, key);
};
