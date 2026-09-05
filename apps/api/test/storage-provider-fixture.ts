import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { storageFailure } from "../src/storage/storage-errors.ts";
import type {
  ObjectMetadata,
  ObjectPart,
  ObjectStore,
} from "../src/storage/objects/object-store.ts";

type Stored = { bytes: Buffer; metadata: ObjectMetadata };
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Stored>();
  readonly uploads = new Map<
    string,
    { key: string; metadata: ObjectMetadata; parts: Map<number, Buffer> }
  >();
  readonly calls: string[] = [];
  failNextRead = false;
  closeCalls = 0;
  readonly bucket: string;
  readonly peers: Map<string, MemoryObjectStore>;
  constructor(bucket: string, peers: Map<string, MemoryObjectStore>) {
    this.bucket = bucket;
    this.peers = peers;
    peers.set(bucket, this);
  }
  close() {
    this.closeCalls += 1;
  }
  async listObjects(prefix: string, cursor?: string, limit = 1000) {
    const all = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .toSorted(([left], [right]) => left.localeCompare(right));
    const start = cursor ? Number(cursor) : 0;
    const page = all.slice(start, start + limit);
    return {
      objects: page.map(([key, object]) => ({
        key,
        bytes: object.bytes.length,
        etag: digest(object.bytes),
      })),
      ...(start + page.length < all.length ? { cursor: String(start + page.length) } : {}),
    };
  }
  async head(key: string) {
    const object = this.objects.get(key);
    return object
      ? {
          bytes: object.bytes.length,
          etag: digest(object.bytes),
          mediaType: object.metadata.mediaType,
        }
      : null;
  }
  async read(key: string, range?: string) {
    if (this.failNextRead) {
      this.failNextRead = false;
      throw storageFailure("STORAGE_PROVIDER_UNAVAILABLE");
    }
    const object = this.objects.get(key);
    if (!object) throw new Error("Missing object");
    const bounds = range?.slice(6).split("-").map(Number);
    const bytes = bounds
      ? object.bytes.subarray(bounds[0], (bounds[1] ?? object.bytes.length - 1) + 1)
      : object.bytes;
    return {
      bytes: bytes.length,
      etag: digest(object.bytes),
      mediaType: object.metadata.mediaType,
      body: Readable.from([bytes]),
    };
  }
  async createMultipart(key: string, metadata: ObjectMetadata) {
    const id = randomUUID();
    this.calls.push(`create:${key}`);
    this.uploads.set(id, { key, metadata, parts: new Map() });
    return id;
  }
  async put(key: string, metadata: ObjectMetadata, body: Readable | Uint8Array, bytes: number) {
    const chunks: Buffer[] = [];
    if (body instanceof Uint8Array) chunks.push(Buffer.from(body));
    else for await (const chunk of body) chunks.push(Buffer.from(chunk));
    const payload = Buffer.concat(chunks);
    if (payload.length !== bytes) throw new Error("Wrong object size");
    this.objects.set(key, { bytes: payload, metadata });
    this.calls.push(`put:${key}`);
    return {};
  }
  async listMultipart(key: string) {
    return [...this.uploads].flatMap(([uploadId, upload]) =>
      upload.key === key ? [{ key, uploadId }] : [],
    );
  }
  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Readable | Uint8Array,
    bytes: number,
  ) {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.key !== key) throw new Error("Invalid session");
    const chunks = [];
    if (body instanceof Uint8Array) chunks.push(Buffer.from(body));
    else for await (const chunk of body) chunks.push(Buffer.from(chunk));
    const payload = Buffer.concat(chunks);
    if (payload.length !== bytes) throw new Error("Wrong part size");
    upload.parts.set(partNumber, payload);
    return digest(payload);
  }
  async copyPart(
    key: string,
    uploadId: string,
    partNumber: number,
    source: { bucket: string; key: string; start: number; end: number },
  ) {
    const object = this.peers.get(source.bucket)?.objects.get(source.key);
    if (!object) throw new Error("Missing source");
    const bytes = object.bytes.subarray(source.start, source.end + 1);
    return this.uploadPart(key, uploadId, partNumber, bytes, bytes.length);
  }
  async listParts(key: string, uploadId: string) {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.key !== key) throw new Error("Invalid session");
    return [...upload.parts]
      .map(([partNumber, bytes]) => ({ partNumber, bytes: bytes.length, etag: digest(bytes) }))
      .toSorted((a, b) => a.partNumber - b.partNumber);
  }
  async complete(key: string, uploadId: string, parts: readonly ObjectPart[]) {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.key !== key) throw new Error("Invalid session");
    const chunks = parts.map((part) => {
      const bytes = upload.parts.get(part.partNumber);
      if (!bytes || digest(bytes) !== part.etag) throw new Error("Invalid part");
      return bytes;
    });
    this.objects.set(key, { bytes: Buffer.concat(chunks), metadata: upload.metadata });
    this.uploads.delete(uploadId);
    this.calls.push(`complete:${key}`);
    return {};
  }
  async abort(_key: string, uploadId: string) {
    this.uploads.delete(uploadId);
  }
  async remove(key: string) {
    this.objects.delete(key);
    this.calls.push(`delete:${key}`);
  }
  async signPart(): Promise<string> {
    throw new Error("Direct-upload signing is tested with the HTTP fixture");
  }
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
