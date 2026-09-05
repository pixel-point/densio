import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HlsPackage, Video } from "@densio/shared";
import { afterEach, expect, it } from "vitest";
import { runCli } from "../src/cli.ts";
import { writeCredentials } from "../src/config.ts";
import {
  cleanupCliDirectories,
  makeCliCapture,
  sendEnvelope,
  startOrganizationCliServer,
} from "./cli-test-support.ts";

afterEach(cleanupCliDirectories);

it.each([
  { corrupt: false, renew: false },
  { corrupt: true, renew: false },
  { corrupt: false, renew: true },
])(
  "downloads private HLS as one verified bundle and preserves existing files on corruption=$corrupt, grant renewal=$renew",
  async ({ corrupt, renew }) => {
    let now = Date.parse("2026-07-11T12:00:00.000Z");
    const requests: string[] = [];
    const server = await startOrganizationCliServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.url === "/v1/organizations/org-1/videos/video-1")
        return sendEnvelope(response, { organizationId: "org-1", video });
      if (request.url?.endsWith("/package/authorize"))
        return sendEnvelope(response, {
          organizationId: "org-1",
          videoId: "video-1",
          package: contents,
          download: {
            method: "GET",
            baseUrl: `${server.url}/package/secret/`,
            expiresAt: new Date(now + 900000).toISOString(),
          },
        });
      const path = decodeURIComponent(request.url?.split("/").at(-1) ?? "");
      if (renew && path === "master.m3u8") now += 960000;
      response.end(corrupt && path.endsWith(".m4s") ? "corrupt segment" : payloads.get(path));
    });
    const capture = await makeCliCapture();
    await writeCredentials(capture.dependencies.credentialsPath, {
      apiUrl: server.url,
      accessToken: "access",
      refreshToken: "refresh",
      accessTokenExpiresAt: "2026-07-11T14:00:00.000Z",
    });
    const directory = join(await realpath(capture.directory), "hls");
    await mkdir(directory);
    await writeFile(join(directory, "master.m3u8"), "existing master");
    const code = await runCli(
      [
        "--json",
        "--api-url",
        server.url,
        "videos",
        "download",
        "video-1",
        "--output-dir",
        directory,
        "--force",
      ],
      { ...capture.dependencies, now: () => now },
    );
    await server.close();
    expect(requests.filter((request) => request.endsWith("/package/authorize"))).toHaveLength(
      renew ? 2 : 1,
    );
    expect(requests).toContain("GET /package/secret/v0%2Fsegment-000000.m4s");
    expect(capture.stdout()).not.toContain("secret");
    if (corrupt) {
      expect(code).not.toBe(0);
      expect(await readFile(join(directory, "master.m3u8"), "utf8")).toBe("existing master");
      expect(await readdir(join(directory, "v0"))).toEqual([]);
      return;
    }
    expect({
      code,
      stderr: capture
        .stderr()
        .split("\n")
        .filter((line) => line.includes('"code"')),
    }).toEqual({ code: 0, stderr: [] });
    const result = JSON.parse(capture.stdout());
    expect(result.data.files).toHaveLength(4);
    for (const [path, bytes] of payloads)
      expect(await readFile(join(directory, path))).toEqual(bytes);
  },
);

const payloads = new Map([
  ["master.m3u8", Buffer.from("#EXTM3U\nv0/index.m3u8\n")],
  ["v0/index.m3u8", Buffer.from('#EXTM3U\n#EXT-X-MAP:URI="init_v0.mp4"\nsegment-000000.m4s\n')],
  ["v0/init_v0.mp4", Buffer.from("initialization")],
  ["v0/segment-000000.m4s", Buffer.from("encoded segment")],
]);
const contents: HlsPackage = {
  packageId: "package-1",
  masterPlaylist: "master.m3u8",
  audio: false,
  packageBytes: [...payloads.values()].reduce((sum, bytes) => sum + bytes.length, 0),
  frameRate: { numerator: 30, denominator: 1, framesPerSecond: 30 },
  renditions: [
    {
      id: "v0",
      width: 640,
      height: 360,
      crf: { h265: 30 },
      playlist: "v0/index.m3u8",
      codecs: "hvc1.2.4.L90.90",
      bandwidth: 100000,
      averageBandwidth: 90000,
      durationSeconds: 1,
      segmentCount: 1,
    },
  ],
  members: [...payloads].map(([path, bytes]) => ({
    path,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    role:
      path === "master.m3u8"
        ? "master"
        : path.endsWith(".m3u8")
          ? "playlist"
          : path.endsWith(".mp4")
            ? "initialization"
            : "segment",
    mediaType: path.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4",
  })),
};
const video: Video = {
  organizationId: "org-1",
  videoId: "video-1",
  jobId: "job-1",
  displayName: "Demo",
  filenameStem: "demo",
  destination: { kind: "managed" },
  visibility: "private",
  visibilityRevision: 0,
  state: "ready",
  variants: [],
  transferId: "transfer-1",
  createdAt: "2026-07-11T12:00:00.000Z",
  hls: {
    packageId: contents.packageId,
    masterPlaylist: contents.masterPlaylist,
    packageBytes: contents.packageBytes,
    renditions: contents.renditions,
  },
};
