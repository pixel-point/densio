import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { makeJobStoragePaths, prepareJobWorkspace } from "../src/storage/workspace.ts";
import { MediaInspector } from "../src/media/inspection/media-inspector.ts";
import { MediaProcessRunner } from "../src/media/process/media-process-runner.ts";
import { normalizeSourceInspection } from "../src/sources/source-inspection.ts";
import { resolveHlsOptions } from "../src/media/hls-policy.ts";
import { runHlsWorkflow } from "../src/media/workflows/hls-workflow.ts";
import { inspectHlsFragment } from "../src/media/hls-fragment.ts";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("encodes aligned HEVC VOD renditions with one shared audio stream and independently decodable segments", async () => {
  const root = await mkdtemp(join(tmpdir(), "densio-hls-"));
  roots.push(root);
  const paths = await Effect.runPromise(makeJobStoragePaths(root, "hls-test"));
  await Effect.runPromise(prepareJobWorkspace(paths));
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=30000/1001:duration=12.5125",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=12.5125",
    "-c:v",
    "ffv1",
    "-c:a",
    "pcm_s16le",
    "-f",
    "matroska",
    paths.inputFile,
  ]);
  const program = Effect.gen(function* () {
    const inspector = yield* MediaInspector;
    const source = yield* normalizeSourceInspection(yield* inspector.inspect(paths.inputFile));
    const options = yield* resolveHlsOptions(source, {
      ladder: { mode: "custom", renditions: [{ height: 54 }, { height: 90 }] },
    });
    return yield* runHlsWorkflow({
      paths,
      source,
      options,
      audioAnalysis: "audible",
      packageId: "package-test",
    });
  }).pipe(
    Effect.provide(MediaInspector.layer()),
    Effect.provide(MediaProcessRunner.layer({ concurrency: 1 })),
  );
  const output = await Effect.runPromise(program);
  expect(output.package.renditions).toMatchObject([
    { height: 54, segmentCount: 3 },
    { height: 90, segmentCount: 3 },
  ]);
  expect(
    output.package.members.filter(
      ({ path }) => path.startsWith("audio/") && path.endsWith(".m3u8"),
    ),
  ).toHaveLength(1);
  const master = await readFile(join(output.directory, "master.m3u8"), "utf8");
  expect(master).toContain("FRAME-RATE=29.970");
  expect(master).toContain('CODECS="hvc1.');
  expect(master).not.toContain("avc1");
  for (const rendition of output.package.renditions) {
    const playlist = await readFile(join(output.directory, rendition.playlist), "utf8");
    const durations = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].map((match) => Number(match[1]));
    expect(durations.slice(0, 2)).toEqual([6.006, 6.006]);
    for (const member of output.package.members.filter(
      ({ path }) => path.startsWith(`${rendition.id}/`) && path.endsWith(".m4s"),
    )) {
      await run("ffmpeg", [
        "-v",
        "error",
        "-xerror",
        "-i",
        `concat:${join(output.directory, rendition.id, `init_${rendition.id}.mp4`)}|${join(output.directory, member.path)}`,
        "-f",
        "null",
        "-",
      ]);
    }
  }
  const archive = await run("unzip", ["-Z1", join(paths.stagingDirectory, "hls.zip")]);
  expect(archive.stdout.trim().split("\n").toSorted()).toEqual(
    output.package.members.map(({ path }) => path).toSorted(),
  );
  await rejectDependentSegment(join(output.directory, "v0", "segment-000001.m4s"));
}, 60000);

const rejectDependentSegment = async (path: string) => {
  const bytes = await readFile(path);
  const runOffset = bytes.indexOf("trun") + 4;
  const flags = bytes.readUInt32BE(runOffset) & 0xffffff;
  expect(flags & (4 | 1024)).not.toBe(0);
  const firstFlags =
    runOffset +
    8 +
    (flags & 1 ? 4 : 0) +
    (flags & 4 ? 0 : (flags & 256 ? 4 : 0) + (flags & 512 ? 4 : 0));
  bytes.writeUInt32BE(bytes.readUInt32BE(firstFlags) | 0x10000, firstFlags);
  await writeFile(path, bytes);
  await expect(inspectHlsFragment(path, 30000, true)).rejects.toThrow("independent sample");
};
