import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { request } from "node:https";
import http from "node:http";
import { assertStorageEndpoint, storageLookup } from "./endpoint-policy.ts";
import { storageFailure } from "../storage-errors.ts";

export const readPublicObject = (
  url: string,
  method: "GET" | "HEAD",
  range: string | undefined,
  allowedOrigins: readonly string[] = [],
  signal?: AbortSignal,
  origin?: string,
) =>
  new Promise<http.IncomingMessage>((resolve, reject) => {
    const target = assertStorageEndpoint(url, true, allowedOrigins);
    const send = target.protocol === "http:" ? http.request : request;
    const outgoing = send(
      target,
      {
        method,
        agent: false,
        ...(allowedOrigins.includes(target.origin) ? {} : { lookup: storageLookup }),
        signal:
          signal === undefined
            ? AbortSignal.timeout(30_000)
            : AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        headers: { ...(range === undefined ? {} : { range }), ...(origin ? { origin } : {}) },
      },
      resolve,
    );
    outgoing.on("error", () => reject(storageFailure("STORAGE_PROVIDER_UNAVAILABLE")));
    outgoing.end();
  });

export const verifyPublicVideo = async (
  url: string,
  bytes: number,
  mediaType: string,
  allowedOrigins: readonly string[] = [],
  signal?: AbortSignal,
  hls = false,
) => {
  if (hls && mediaType === "application/vnd.apple.mpegurl")
    return verifyPublicPlaylist(url, bytes, allowedOrigins, signal);
  const head = await readPublicObject(
    url,
    "HEAD",
    undefined,
    allowedOrigins,
    signal,
    hls ? playbackOrigin : undefined,
  );
  const valid =
    head.statusCode === 200 &&
    (!hls || allowsPlayback(head)) &&
    Number(head.headers["content-length"]) === bytes &&
    head.headers["content-type"]?.split(";")[0] === mediaType;
  head.destroy();
  if (!valid)
    throw storageFailure(
      "STORAGE_PUBLIC_DELIVERY_REQUIRED",
      "The final URL does not serve the expected public video.",
    );
  const partial = await readPublicObject(
    url,
    "GET",
    "bytes=0-0",
    allowedOrigins,
    signal,
    hls ? playbackOrigin : undefined,
  );
  const ranged =
    partial.statusCode === 206 &&
    (!hls || allowsPlayback(partial)) &&
    partial.headers["content-range"] === `bytes 0-0/${bytes}` &&
    Number(partial.headers["content-length"]) === 1;
  partial.destroy();
  if (!ranged)
    throw storageFailure(
      "STORAGE_PUBLIC_DELIVERY_REQUIRED",
      "The public URL must support ranged video playback.",
    );
};

const playbackOrigin = "https://densio-playback-check.invalid";
const allowsPlayback = (response: http.IncomingMessage) =>
  ["*", playbackOrigin].includes(String(response.headers["access-control-allow-origin"]));

const verifyPublicPlaylist = async (
  url: string,
  bytes: number,
  allowedOrigins: readonly string[],
  signal?: AbortSignal,
) => {
  const response = await readPublicObject(
    url,
    "GET",
    undefined,
    allowedOrigins,
    signal,
    playbackOrigin,
  );
  if (
    response.statusCode !== 200 ||
    !allowsPlayback(response) ||
    !["application/vnd.apple.mpegurl", "application/x-mpegURL"].includes(
      response.headers["content-type"]?.split(";")[0] ?? "",
    )
  ) {
    response.destroy();
    throw storageFailure(
      "STORAGE_PUBLIC_DELIVERY_REQUIRED",
      "HLS playlists require their media type and cross-origin GET access.",
    );
  }
  const encoding = response.headers["content-encoding"];
  const decoder =
    encoding === "gzip"
      ? createGunzip()
      : encoding === "br"
        ? createBrotliDecompress()
        : encoding === "deflate"
          ? createInflate()
          : undefined;
  if (encoding && encoding !== "identity" && !decoder) {
    response.destroy();
    throw storageFailure("STORAGE_PUBLIC_DELIVERY_REQUIRED");
  }
  const body = decoder ? response.pipe(decoder) : response;
  response.on("error", (error) => body.destroy(error));
  const chunks: Buffer[] = [];
  let size = 0;
  return Promise.resolve()
    .then(async () => {
      for await (const chunk of body) {
        size += chunk.length;
        if (size > Math.min(bytes, 4 * 1024 * 1024))
          throw storageFailure("STORAGE_PUBLIC_DELIVERY_REQUIRED");
        chunks.push(Buffer.from(chunk));
      }
      if (size !== bytes || !Buffer.concat(chunks).toString("utf8").startsWith("#EXTM3U\n"))
        throw storageFailure("STORAGE_PUBLIC_DELIVERY_REQUIRED");
    })
    .finally(() => {
      body.destroy();
      response.destroy();
    });
};
