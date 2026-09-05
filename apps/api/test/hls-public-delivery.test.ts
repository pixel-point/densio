import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { verifyPublicVideo } from "../src/storage/objects/public-delivery.ts";

test("HLS delivery accepts compressed playlists and requires cross-origin media access", async () => {
  const playlist = "#EXTM3U\n#EXT-X-ENDLIST\n";
  const compressed = gzipSync(playlist);
  const server = createServer((request, response) => {
    const cors = request.url === "/no-cors.m3u8" ? {} : { "access-control-allow-origin": "*" };
    if (request.url?.endsWith(".m3u8")) {
      response.writeHead(200, {
        ...cors,
        "content-type": "application/vnd.apple.mpegurl",
        "content-encoding": "gzip",
        "content-length": compressed.length,
      });
      response.end(request.method === "HEAD" ? undefined : compressed);
      return;
    }
    response.writeHead(request.headers.range ? 206 : 200, {
      ...cors,
      "content-type": "video/mp4",
      "content-length": request.headers.range ? 1 : 4,
      ...(request.headers.range ? { "content-range": "bytes 0-0/4" } : {}),
    });
    response.end(request.method === "HEAD" ? undefined : "x");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await Promise.resolve()
    .then(async () => {
      await verifyPublicVideo(
        `${origin}/master.m3u8`,
        Buffer.byteLength(playlist),
        "application/vnd.apple.mpegurl",
        [origin],
        undefined,
        true,
      );
      await verifyPublicVideo(`${origin}/segment.m4s`, 4, "video/mp4", [origin], undefined, true);
      await expect(
        verifyPublicVideo(
          `${origin}/no-cors.m3u8`,
          Buffer.byteLength(playlist),
          "application/vnd.apple.mpegurl",
          [origin],
          undefined,
          true,
        ),
      ).rejects.toMatchObject({ code: "STORAGE_PUBLIC_DELIVERY_REQUIRED" });
    })
    .finally(() => new Promise<void>((resolve) => server.close(() => resolve())));
});
