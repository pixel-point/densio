import type { Readable } from "node:stream";

export interface ObjectFacts {
  readonly bytes: number;
  readonly etag: string;
  readonly versionId?: string;
  readonly mediaType?: string;
}
export interface ObjectMetadata {
  readonly mediaType: string;
  readonly filename: string;
  readonly sha256: string;
  readonly public: boolean;
}
export interface ObjectPart {
  readonly partNumber: number;
  readonly etag: string;
  readonly bytes: number;
}
export interface ObjectListing {
  readonly objects: readonly { key: string; bytes: number; etag: string; lastModified?: number }[];
  readonly cursor?: string;
}
export interface ObjectStore {
  readonly bucket: string;
  listObjects(
    prefix: string,
    cursor?: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<ObjectListing>;
  head(key: string, versionId?: string, signal?: AbortSignal): Promise<ObjectFacts | null>;
  read(
    key: string,
    range?: string,
    versionId?: string,
    signal?: AbortSignal,
  ): Promise<ObjectFacts & { body: Readable }>;
  put(
    key: string,
    metadata: ObjectMetadata,
    body: Readable | Uint8Array,
    bytes: number,
    signal?: AbortSignal,
  ): Promise<{ versionId?: string }>;
  createMultipart(key: string, metadata: ObjectMetadata, signal?: AbortSignal): Promise<string>;
  listMultipart(
    key: string,
    signal?: AbortSignal,
  ): Promise<readonly { key: string; uploadId: string }[]>;
  uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Readable | Uint8Array,
    bytes: number,
    signal?: AbortSignal,
  ): Promise<string>;
  copyPart(
    key: string,
    uploadId: string,
    partNumber: number,
    source: { bucket: string; key: string; start: number; end: number; versionId?: string },
    signal?: AbortSignal,
  ): Promise<string>;
  listParts(key: string, uploadId: string, signal?: AbortSignal): Promise<readonly ObjectPart[]>;
  complete(
    key: string,
    uploadId: string,
    parts: readonly ObjectPart[],
    signal?: AbortSignal,
  ): Promise<{ versionId?: string }>;
  abort(key: string, uploadId: string, signal?: AbortSignal): Promise<void>;
  remove(key: string, versionId?: string, signal?: AbortSignal): Promise<void>;
  signPart(
    key: string,
    uploadId: string,
    partNumber: number,
    bytes: number,
    expiresIn: number,
  ): Promise<string>;
  close(): void;
}
export interface StorageTarget {
  readonly id: string;
  readonly role: "public" | "private" | "staging";
  readonly store: ObjectStore;
  readonly publicOrigin?: string;
}
