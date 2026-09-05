import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  UploadPartCommand,
  UploadPartCopyCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ObjectStore } from "./object-store.ts";
import { missingObject, objectRequestOptions, providerFailure } from "./s3-client.ts";
import { assertStorageEndpoint, resolveStorageAddress } from "./endpoint-policy.ts";

export const multipartOperations = (
  client: S3Client,
  bucket: string,
  allowedOrigins: readonly string[],
): Pick<
  ObjectStore,
  | "createMultipart"
  | "put"
  | "listMultipart"
  | "uploadPart"
  | "copyPart"
  | "listParts"
  | "complete"
  | "abort"
  | "signPart"
> => ({
  put: (...args) => putObject(client, bucket, ...args),
  createMultipart: (...args) => createMultipart(client, bucket, ...args),
  listMultipart: (key, signal) => listMultipart(client, bucket, key, signal),
  uploadPart: async (key, uploadId, partNumber, body, bytes, signal) => {
    const result = await client
      .send(
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: body,
          ContentLength: bytes,
        }),
        objectRequestOptions(signal),
      )
      .catch(providerFailure);
    if (!result.ETag) return providerFailure(undefined);
    return result.ETag;
  },
  copyPart: (...args) => copyPart(client, bucket, ...args),
  listParts: (key, uploadId, signal) => listParts(client, bucket, key, uploadId, signal),
  complete: async (key, uploadId, parts, signal) => {
    const result = await client
      .send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map((part) => ({ ETag: part.etag, PartNumber: part.partNumber })),
          },
        }),
        objectRequestOptions(signal),
      )
      .catch(providerFailure);
    return result.VersionId === undefined ? {} : { versionId: result.VersionId };
  },
  abort: async (key, uploadId, signal) => {
    await client
      .send(
        new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
        objectRequestOptions(signal),
      )
      .catch((error: unknown) => {
        if (!missingObject(error)) providerFailure(error);
      });
  },
  signPart: async (key, uploadId, partNumber, bytes, expiresIn) => {
    const url = await getSignedUrl(
      client,
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        ContentLength: bytes,
      }),
      { expiresIn, signableHeaders: new Set(["content-length"]) },
    ).catch(providerFailure);
    const parsed = new URL(url);
    assertStorageEndpoint(parsed.origin, false, allowedOrigins);
    if (!allowedOrigins.includes(parsed.origin))
      await resolveStorageAddress(parsed.hostname).catch(providerFailure);
    return url;
  },
});

const listMultipart = async (
  client: S3Client,
  bucket: string,
  key: string,
  signal?: AbortSignal,
) => {
  const uploads: { key: string; uploadId: string }[] = [];
  let keyMarker: string | undefined;
  let uploadMarker: string | undefined;
  do {
    const page = await client
      .send(
        new ListMultipartUploadsCommand({
          Bucket: bucket,
          Prefix: key,
          KeyMarker: keyMarker,
          UploadIdMarker: uploadMarker,
        }),
        objectRequestOptions(signal),
      )
      .catch(providerFailure);
    uploads.push(
      ...(page.Uploads ?? []).flatMap((upload) =>
        upload.Key === key && upload.UploadId ? [{ key, uploadId: upload.UploadId }] : [],
      ),
    );
    if (!page.IsTruncated) return uploads;
    if (
      !page.NextKeyMarker ||
      (keyMarker === page.NextKeyMarker && uploadMarker === page.NextUploadIdMarker)
    )
      return providerFailure(undefined);
    keyMarker = page.NextKeyMarker;
    uploadMarker = page.NextUploadIdMarker;
  } while (keyMarker !== undefined);
  return uploads;
};
const listParts = async (
  client: S3Client,
  bucket: string,
  key: string,
  uploadId: string,
  signal?: AbortSignal,
) => {
  const parts: { partNumber: number; etag: string; bytes: number }[] = [];
  let marker: string | undefined;
  do {
    const page = await client
      .send(
        new ListPartsCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: marker,
        }),
        objectRequestOptions(signal),
      )
      .catch(providerFailure);
    parts.push(
      ...(page.Parts ?? []).flatMap((part) =>
        part.PartNumber && part.ETag && part.Size !== undefined
          ? [{ partNumber: part.PartNumber, etag: part.ETag, bytes: part.Size }]
          : [],
      ),
    );
    if (!page.IsTruncated) return parts;
    if (!page.NextPartNumberMarker || marker === page.NextPartNumberMarker)
      return providerFailure(undefined);
    marker = page.NextPartNumberMarker;
  } while (marker !== undefined);
  return parts;
};

const copyPart = async (
  client: S3Client,
  bucket: string,
  ...args: Parameters<ObjectStore["copyPart"]>
) => {
  const [key, uploadId, partNumber, source, signal] = args;

  const sourcePath = `${encodeURIComponent(source.bucket)}/${source.key.split("/").map(encodeURIComponent).join("/")}${source.versionId ? `?versionId=${encodeURIComponent(source.versionId)}` : ""}`;
  const result = await client
    .send(
      new UploadPartCopyCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        CopySource: sourcePath,
        CopySourceRange: `bytes=${source.start}-${source.end}`,
      }),
      objectRequestOptions(signal),
    )
    .catch(providerFailure);
  if (!result.CopyPartResult?.ETag) return providerFailure(undefined);
  return result.CopyPartResult.ETag;
};

const putObject = async (
  client: S3Client,
  bucket: string,
  ...args: Parameters<ObjectStore["put"]>
) => {
  const [key, metadata, body, bytes, signal] = args;
  const result = await client
    .send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentLength: bytes,
        ContentType: metadata.mediaType,
        ContentDisposition: `inline; filename="${metadata.filename}"`,
        CacheControl: metadata.public
          ? "public, max-age=60, s-maxage=86400, must-revalidate"
          : "private, no-store",
        Metadata: { "densio-sha256": metadata.sha256 },
      }),
      objectRequestOptions(signal),
    )
    .catch(providerFailure);
  return result.VersionId === undefined ? {} : { versionId: result.VersionId };
};

const createMultipart = async (
  client: S3Client,
  bucket: string,
  ...args: Parameters<ObjectStore["createMultipart"]>
) => {
  const [key, metadata, signal] = args;
  const result = await client
    .send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        ContentType: metadata.mediaType,
        ContentDisposition: `inline; filename="${metadata.filename}"`,
        CacheControl: metadata.public
          ? "public, max-age=60, s-maxage=86400, must-revalidate"
          : "private, no-store",
        Metadata: { "densio-sha256": metadata.sha256 },
      }),
      objectRequestOptions(signal),
    )
    .catch(providerFailure);
  if (!result.UploadId) return providerFailure(undefined);
  return result.UploadId;
};
