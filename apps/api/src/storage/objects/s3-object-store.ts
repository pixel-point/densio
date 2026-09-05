import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import type { StorageCredentials, StorageLocation } from "@densio/shared";
import type { ObjectFacts, ObjectStore } from "./object-store.ts";
import {
  makeStorageS3Client,
  missingObject,
  objectRequestOptions,
  providerFailure,
} from "./s3-client.ts";
import { multipartOperations } from "./s3-multipart.ts";
import { s3ObjectVersion, s3VersionResult, supportsS3ObjectVersions } from "./s3-versioning.ts";

export const makeS3ObjectStore = (
  location: StorageLocation,
  credentials: StorageCredentials,
  options: {
    readonly allowedOrigins?: readonly string[];
    readonly supportsObjectVersions?: boolean;
  } = {},
): ObjectStore => {
  const client = makeStorageS3Client(location, credentials, options.allowedOrigins ?? []);
  const versioned = options.supportsObjectVersions ?? supportsS3ObjectVersions(location.endpoint);
  return {
    bucket: location.bucket,
    close: () => client.destroy(),
    ...multipartOperations(client, location.bucket, options.allowedOrigins ?? [], versioned),
    listObjects: async (prefix, cursor, limit = 1000, signal) => {
      const result = await client
        .send(
          new ListObjectsV2Command({
            Bucket: location.bucket,
            Prefix: prefix,
            ContinuationToken: cursor,
            MaxKeys: limit,
          }),
          objectRequestOptions(signal),
        )
        .catch(providerFailure);
      return {
        objects: (result.Contents ?? []).map((object) => {
          if (!object.Key || object.Size === undefined || !object.ETag)
            return providerFailure(undefined);
          return {
            key: object.Key,
            bytes: object.Size,
            etag: object.ETag,
            ...(object.LastModified ? { lastModified: object.LastModified.getTime() } : {}),
          };
        }),
        ...(result.IsTruncated && result.NextContinuationToken
          ? { cursor: result.NextContinuationToken }
          : {}),
      };
    },
    head: async (key, versionId, signal) => {
      const result = await client
        .send(
          new HeadObjectCommand({
            Bucket: location.bucket,
            Key: key,
            VersionId: s3ObjectVersion(versioned, versionId),
          }),
          objectRequestOptions(signal),
        )
        .catch((error: unknown) => (missingObject(error) ? null : providerFailure(error)));
      return result === null ? null : objectFacts(result, versioned);
    },
    read: async (key, range, versionId, signal) => {
      const result = await client
        .send(
          new GetObjectCommand({
            Bucket: location.bucket,
            Key: key,
            VersionId: s3ObjectVersion(versioned, versionId),
            Range: range,
          }),
          objectRequestOptions(signal),
        )
        .catch(providerFailure);
      if (!(result.Body instanceof Readable)) return providerFailure(undefined);
      return { ...objectFacts(result, versioned), body: result.Body };
    },
    remove: async (key, versionId, signal) => {
      await client
        .send(
          new DeleteObjectCommand({
            Bucket: location.bucket,
            Key: key,
            VersionId: s3ObjectVersion(versioned, versionId),
          }),
          objectRequestOptions(signal),
        )
        .catch(providerFailure);
    },
  };
};
const objectFacts = (
  result: {
    ContentLength?: number | undefined;
    ETag?: string | undefined;
    VersionId?: string | undefined;
    ContentType?: string | undefined;
  },
  versioned: boolean,
): ObjectFacts => {
  if (result.ContentLength === undefined || result.ETag === undefined)
    return providerFailure(undefined);
  return {
    bytes: result.ContentLength,
    etag: result.ETag,
    ...s3VersionResult(versioned, result.VersionId),
    ...(result.ContentType === undefined ? {} : { mediaType: result.ContentType }),
  };
};
