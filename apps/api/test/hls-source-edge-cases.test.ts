import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { MediaInspector } from "../src/media/inspection/media-inspector.ts";
import { MediaProcessRunner } from "../src/media/process/media-process-runner.ts";
import { normalizeSourceInspection } from "../src/sources/source-inspection.ts";
import { resolveHlsOptions } from "../src/media/hls-policy.ts";
import { runHlsWorkflow } from "../src/media/workflows/hls-workflow.ts";
import { makeJobStoragePaths, prepareJobWorkspace } from "../src/storage/workspace.ts";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each(["audio", "video"])(
  "normalizes VFR while preserving a delayed %s track",
  async (delayed) => {
    const paths = await fixturePaths();
    await run("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      ...(delayed === "video" ? ["-itsoffset", "1"] : []),
      "-i",
      "testsrc2=size=96x64:rate=25:duration=7",
      ...(delayed === "audio" ? ["-itsoffset", "1"] : []),
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=6",
      "-vf",
      "select='if(lt(t,3),1,not(mod(n,2)))'",
      "-fps_mode",
      "vfr",
      "-c:v",
      "ffv1",
      "-c:a",
      "pcm_s16le",
      "-f",
      "matroska",
      paths.inputFile,
    ]);
    const output = await encode(paths);
    const video = await packets(join(output.directory, "v0/index.m3u8"));
    const audio = await packets(join(output.directory, "audio/index.m3u8"));
    const firstVideo = Math.min(...video.map(({ pts_time }) => Number(pts_time)));
    const firstAudio = Number(audio[0]?.pts_time);
    expect(Math.abs(firstAudio - firstVideo - (delayed === "audio" ? 1 : -1))).toBeLessThan(0.07);
    const ticks = video
      .slice(1)
      .map((packet, index) => Number(packet.dts_time) - Number(video[index]?.dts_time));
    expect(Math.max(...ticks) - Math.min(...ticks)).toBeLessThan(0.00001);
    expect(output.package.renditions[0]?.segmentCount).toBe(2);
  },
  60000,
);

it("preserves rotated anamorphic SDR geometry and color metadata with square output pixels", async () => {
  const paths = await fixturePaths();
  const unrotated = join(paths.stagingDirectory, "unrotated.mp4");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=25:duration=1",
    "-vf",
    "setsar=2/1",
    "-c:v",
    "libx265",
    "-preset",
    "ultrafast",
    "-x265-params",
    "pools=1:frame-threads=1:colorprim=bt709:transfer=bt709:colormatrix=bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-colorspace",
    "bt709",
    "-color_range",
    "tv",
    unrotated,
  ]);
  await run("ffmpeg", [
    "-v",
    "error",
    "-display_rotation:v:0",
    "90",
    "-i",
    unrotated,
    "-c",
    "copy",
    "-f",
    "mp4",
    paths.inputFile,
  ]);
  const output = await encode(paths, false);
  const probe = JSON.parse(
    (
      await run("ffprobe", [
        "-v",
        "error",
        "-show_streams",
        "-of",
        "json",
        join(output.directory, "v0/index.m3u8"),
      ])
    ).stdout,
  );
  expect(probe.streams[0]).toMatchObject({
    codec_name: "hevc",
    width: 90,
    height: 320,
    sample_aspect_ratio: "1:1",
    color_primaries: "bt709",
    color_transfer: "bt709",
    color_space: "bt709",
    color_range: "tv",
  });
  expect(output.package.audio).toBe(false);
}, 60000);

const fixturePaths = async () => {
  const root = await mkdtemp(join(tmpdir(), "densio-hls-source-"));
  roots.push(root);
  const paths = await Effect.runPromise(makeJobStoragePaths(root, "source-cases"));
  await Effect.runPromise(prepareJobWorkspace(paths));
  return paths;
};

const encode = (paths: Awaited<ReturnType<typeof fixturePaths>>, audio = true) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const inspector = yield* MediaInspector;
      const source = yield* normalizeSourceInspection(yield* inspector.inspect(paths.inputFile));
      const options = yield* resolveHlsOptions(source, {
        audio: audio ? "keep" : "remove",
        frameRate: { mode: "preserve" },
      });
      return yield* runHlsWorkflow({
        paths,
        source,
        options,
        audioAnalysis: audio ? "audible" : "absent",
        packageId: "source-cases",
      });
    }).pipe(
      Effect.provide(MediaInspector.layer()),
      Effect.provide(MediaProcessRunner.layer({ concurrency: 1 })),
    ),
  );

const packets = async (
  path: string,
): Promise<Array<{ pts_time: string; dts_time: string; flags: string }>> =>
  JSON.parse(
    (
      await run("ffprobe", [
        "-v",
        "error",
        "-show_packets",
        "-show_entries",
        "packet=pts_time,dts_time,flags",
        "-of",
        "json",
        path,
      ])
    ).stdout,
  ).packets;
