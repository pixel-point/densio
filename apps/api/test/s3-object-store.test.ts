import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { supportsS3ObjectVersions } from "../src/storage/objects/s3-versioning.ts";
import { makeS3ObjectStore } from "../src/storage/objects/s3-object-store.ts";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});
const fixtureServer = async (
  handler: (request: IncomingMessage, response: ServerResponse) => void,
) => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

test("S3 transport signs requests, streams bytes, preserves metadata and treats missing objects explicitly", async () => {
  const endpoint = await fixtureServer((request, response) => {
    expect(request.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    if (request.url?.includes("missing")) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-length": "5",
      "content-type": "video/webm",
      etag: '"fixture"',
    });
    response.end(request.method === "HEAD" ? undefined : "video");
  });
  const store = makeS3ObjectStore(
    { endpoint, region: "auto", bucket: "fixture-bucket", prefix: "", pathStyle: true },
    { accessKeyId: "fixture", secretAccessKey: "fixture-secret" },
    { allowedOrigins: [endpoint] },
  );
  expect(await store.head("video.webm")).toMatchObject({ bytes: 5, etag: '"fixture"' });
  expect(await store.head("missing.webm")).toBeNull();
  const object = await store.read("video.webm");
  const chunks = [];
  for await (const chunk of object.body) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString()).toBe("video");
  store.close();
});

test("S3 transport never follows a provider redirect or leaks credentials in errors", async () => {
  const endpoint = await fixtureServer((_request, response) =>
    response.writeHead(307, { location: "http://169.254.169.254/" }).end(),
  );
  const store = makeS3ObjectStore(
    { endpoint, region: "auto", bucket: "fixture-bucket", prefix: "", pathStyle: true },
    { accessKeyId: "fixture", secretAccessKey: "fixture-secret" },
    { allowedOrigins: [endpoint] },
  );
  await expect(store.head("video.webm")).rejects.toMatchObject({
    code: "STORAGE_PROVIDER_UNAVAILABLE",
  });
  store.close();
});

test("small package objects use one signed PUT with delivery metadata", async () => {
  const requests: string[] = [];
  const endpoint = await fixtureServer((request, response) => {
    requests.push(request.method ?? "");
    expect(request.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(request.headers["content-type"]).toBe("application/vnd.apple.mpegurl");
    expect(request.headers["cache-control"]).toContain("public");
    expect(request.headers["x-amz-meta-densio-sha256"]).toBe("fixture-digest");
    request.resume();
    request.on("end", () => response.writeHead(200, { etag: '"fixture"' }).end());
  });
  const store = makeS3ObjectStore(
    { endpoint, region: "auto", bucket: "fixture-bucket", prefix: "", pathStyle: true },
    { accessKeyId: "fixture", secretAccessKey: "fixture-secret" },
    { allowedOrigins: [endpoint] },
  );
  await store.put(
    "master.m3u8",
    {
      filename: "master.m3u8",
      mediaType: "application/vnd.apple.mpegurl",
      sha256: "fixture-digest",
      public: true,
    },
    Buffer.from("#EXTM3U\n"),
    8,
  );
  expect(requests).toEqual(["PUT"]);
  store.close();
});

test.each([true, false])(
  "S3 object version capability %s applies to writes, reads, copies and deletion",
  async (supportsObjectVersions) => {
    const versionId = "provider-object-version";
    const endpoint = await fixtureServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://fixture.invalid");
      const copySource = request.headers["x-amz-copy-source"];
      if (copySource)
        expect(String(copySource).includes("versionId=")).toBe(supportsObjectVersions);
      if (["HEAD", "GET", "DELETE"].includes(request.method ?? ""))
        expect(url.searchParams.get("versionId")).toBe(supportsObjectVersions ? versionId : null);
      const body = copySource
        ? '<CopyPartResult><ETag>"copy"</ETag></CopyPartResult>'
        : request.method === "POST"
          ? '<CompleteMultipartUploadResult><ETag>"complete"</ETag></CompleteMultipartUploadResult>'
          : request.method === "GET"
            ? "video"
            : "";
      response.writeHead(200, {
        "content-length": request.method === "HEAD" ? "5" : String(Buffer.byteLength(body)),
        "content-type": "video/webm",
        "x-amz-version-id": versionId,
        etag: '"fixture"',
      });
      request.resume();
      response.end(body);
    });
    const store = makeS3ObjectStore(
      { endpoint, region: "auto", bucket: "fixture-bucket", prefix: "", pathStyle: true },
      { accessKeyId: "fixture", secretAccessKey: "fixture-secret" },
      { allowedOrigins: [endpoint], supportsObjectVersions },
    );
    const version = supportsObjectVersions ? { versionId } : {};
    const metadata = {
      filename: "video.webm",
      mediaType: "video/webm",
      public: false,
      sha256: "digest",
    };
    expect(await store.put("video.webm", metadata, Buffer.from("video"), 5)).toEqual(version);
    expect(await store.complete("video.webm", "upload", [])).toEqual(version);
    const head = await store.head("video.webm", versionId);
    expect(head?.versionId).toBe(supportsObjectVersions ? versionId : undefined);
    const object = await store.read("video.webm", undefined, versionId);
    expect(object.versionId).toBe(supportsObjectVersions ? versionId : undefined);
    const chunks = [];
    for await (const chunk of object.body) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("video");
    expect(
      await store.copyPart("copy.webm", "upload", 1, {
        bucket: "fixture-bucket",
        key: "video.webm",
        versionId,
        start: 0,
        end: 4,
      }),
    ).toBe('"copy"');
    await store.remove("video.webm", versionId);
    store.close();
  },
);

test.each([
  ["https://account.r2.cloudflarestorage.com", false],
  ["https://account.eu.r2.cloudflarestorage.com", false],
  ["https://s3.us-east-1.amazonaws.com", true],
  ["https://account.r2.cloudflarestorage.com.example.org", true],
])("object version capability for %s is %s", (endpoint, supported) => {
  expect(supportsS3ObjectVersions(endpoint)).toBe(supported);
});
