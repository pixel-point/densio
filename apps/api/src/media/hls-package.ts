import { hevcCodecFromInitialization } from "./hevc-codec.ts";
import { hlsTrackTimescale, inspectHlsFragment } from "./hls-fragment.ts";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  HlsMemberPathSchema,
  HlsPackageSchema,
  type HlsMember,
  type ResolvedHlsOptions,
} from "@densio/shared";
import { Effect, Schema } from "effect";
import { workflowFileOperation } from "./workflows/workflow-staging.ts";
import { measuredHlsBandwidth, nativeHevcCodec, parseHlsMediaPlaylist } from "./hls-playlist.ts";

export const finalizeHlsPackage = Effect.fn("HlsPackage.finalize")(function* (
  directory: string,
  packageId: string,
  options: ResolvedHlsOptions,
  audio: boolean,
) {
  const nativeMaster = yield* workflowFileOperation("read-master-playlist", () =>
    readFile(join(directory, "master.m3u8"), "utf8"),
  );
  const tracks = yield* Effect.forEach(
    [...options.renditions.map(({ id }) => id), ...(audio ? ["audio"] : [])],
    (id) => workflowFileOperation("validate-playlist", () => inspectTrack(directory, id)),
  );
  const audioTrack = tracks.find(({ id }) => id === "audio");
  const renditions = yield* workflowFileOperation("validate-aligned-renditions", async () =>
    options.renditions.map((rendition, index) => {
      const track = tracks[index];
      const reference = tracks[0];
      if (
        !track ||
        !reference ||
        !track.codec ||
        track.segments.length !== reference.segments.length ||
        track.segments.some(
          (segment, segmentIndex) =>
            Math.abs(segment.duration - (reference.segments[segmentIndex]?.duration ?? 0)) >
              0.00001 ||
            Math.abs(
              segment.presentation - (reference.segments[segmentIndex]?.presentation ?? -1),
            ) > 0.00001,
        )
      )
        throw new Error("HLS video renditions do not align");
      return {
        ...rendition,
        playlist: `${rendition.id}/index.m3u8`,
        codecs: `${nativeHevcCodec(nativeMaster, `${rendition.id}/index.m3u8`) ?? track.codec}${audio ? ",mp4a.40.2" : ""}`,
        bandwidth: track.bandwidth.peak + (audioTrack?.bandwidth.peak ?? 0),
        averageBandwidth: track.bandwidth.average + (audioTrack?.bandwidth.average ?? 0),
        segmentCount: track.segments.length,
        durationSeconds: track.duration,
      };
    }),
  );
  const master = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    "#EXT-X-INDEPENDENT-SEGMENTS",
    ...(audio
      ? [
          '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="audio/index.m3u8"',
        ]
      : []),
    ...renditions.flatMap((rendition) => [
      `#EXT-X-STREAM-INF:BANDWIDTH=${rendition.bandwidth},AVERAGE-BANDWIDTH=${rendition.averageBandwidth},CODECS="${rendition.codecs}",RESOLUTION=${rendition.width}x${rendition.height},FRAME-RATE=${options.outputFrameRate.framesPerSecond.toFixed(3)},VIDEO-RANGE=SDR${audio ? ',AUDIO="audio"' : ""}`,
      rendition.playlist,
    ]),
    "",
  ].join("\n");
  yield* workflowFileOperation("finalize-master-playlist", () =>
    writeFile(join(directory, "master.m3u8"), master),
  );
  const paths = [
    "master.m3u8",
    ...tracks.flatMap((track) => [
      `${track.id}/index.m3u8`,
      `${track.id}/init_${track.id}.mp4`,
      ...track.segments.map(({ path }) => path),
    ]),
  ];
  yield* workflowFileOperation("validate-package-tree", () => validateTree(directory, paths));
  const members = yield* Effect.forEach(
    paths,
    (path) => workflowFileOperation("measure-package-member", () => measureMember(directory, path)),
    { concurrency: 4 },
  );
  return yield* Schema.decodeUnknownEffect(HlsPackageSchema)({
    packageId,
    masterPlaylist: "master.m3u8",
    frameRate: options.outputFrameRate,
    audio,
    renditions,
    members,
    packageBytes: members.reduce((sum, member) => sum + member.bytes, 0),
  });
});

const measureMember = async (directory: string, path: string): Promise<HlsMember> => {
  Schema.decodeUnknownSync(HlsMemberPathSchema)(path);
  const metadata = await lstat(join(directory, path));
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0)
    throw new Error("Invalid HLS package member");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(join(directory, path))) hash.update(chunk);
  return {
    path,
    role:
      path === "master.m3u8"
        ? "master"
        : path.endsWith(".m3u8")
          ? "playlist"
          : path.endsWith(".mp4")
            ? "initialization"
            : "segment",
    mediaType: path.endsWith(".m3u8")
      ? "application/vnd.apple.mpegurl"
      : path.startsWith("audio/")
        ? "audio/mp4"
        : "video/mp4",
    bytes: metadata.size,
    sha256: hash.digest("hex"),
  };
};

const validateTree = async (directory: string, expected: ReadonlyArray<string>) => {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  if (entries.length > 20004 || entries.some((entry) => entry.isSymbolicLink()))
    throw new Error("Invalid HLS package tree");
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1));
  if (files.length !== expected.length || files.some((path) => !expected.includes(path)))
    throw new Error("HLS inventory does not match package files");
};

const inspectTrack = async (directory: string, id: string) => {
  const path = join(directory, id, "index.m3u8");
  const original = await readFile(path, "utf8");
  const normalized = original.replace(/#EXT-X-TARGETDURATION:0\n/, "#EXT-X-TARGETDURATION:1\n");
  if (normalized !== original) await writeFile(path, normalized);
  const playlist = parseHlsMediaPlaylist(normalized, id);
  const initialization = await readFile(join(directory, id, `init_${id}.mp4`));
  const timescale = hlsTrackTimescale(initialization);
  const segments: Array<
    { path: string; duration: number; bytes: number } & Awaited<
      ReturnType<typeof inspectHlsFragment>
    >
  > = [];
  for (const segment of playlist.segments) {
    segments.push({
      ...segment,
      bytes: (await lstat(join(directory, segment.path))).size,
      ...(await inspectHlsFragment(join(directory, segment.path), timescale, id !== "audio")),
    });
  }
  if (
    segments.some(
      (segment, index) =>
        Math.abs(segment.end - segment.start - segment.duration) > 0.05 ||
        (index > 0 && Math.abs(segment.start - segments[index - 1]!.end) > 1 / timescale),
    )
  )
    throw new Error("HLS fragment timeline is discontinuous or differs from its playlist");
  return {
    id,
    ...playlist,
    segments,
    codec: id === "audio" ? undefined : hevcCodecFromInitialization(initialization),
    bandwidth: measuredHlsBandwidth(segments, playlist.targetDuration),
  };
};
