import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { Effect } from "effect";
import { normalizeSourceInspection } from "../src/sources/source-inspection.ts";
import { decodeMediaProbe } from "../src/media/inspection/media-probe.ts";
import { resolveHlsOptions } from "../src/media/hls-policy.ts";
import { buildHlsCommand } from "../src/media/hls-command.ts";
import { finalizeHlsPackage } from "../src/media/hls-package.ts";

const run = promisify(execFile);
const sourceMovie = process.argv[2];
const root = resolve(process.argv[3] ?? join(tmpdir(), "densio-hls-benchmark"));
if (!sourceMovie) throw new Error("Usage: benchmark-hls.ts SOURCE_MOVIE OUTPUT_DIRECTORY");
await mkdir(root, { recursive: true });
const results = [];
for (const scene of ["animation-calm", "animation-action", "motion-noise"]) {
  const inputPath = join(root, `${scene}.mkv`);
  await run("ffmpeg", [
    "-v",
    "error",
    "-y",
    ...(scene === "motion-noise"
      ? [
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=640x360:rate=30:duration=30,noise=alls=8:allf=t:all_seed=42",
        ]
      : [
          "-ss",
          scene === "animation-calm" ? "60" : "420",
          "-i",
          sourceMovie,
          "-t",
          "30",
          "-vf",
          "scale=640:360:flags=lanczos,fps=30,setsar=1",
        ]),
    "-an",
    "-c:v",
    "ffv1",
    inputPath,
  ]);
  const probe = await run("ffprobe", [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    inputPath,
  ]);
  const source = await Effect.runPromise(
    Effect.flatMap(decodeMediaProbe(probe.stdout), normalizeSourceInspection),
  );
  for (const profile of ["main8-crf", "main10-crf", "main10-capped"]) {
    const options = await Effect.runPromise(
      resolveHlsOptions(source, {
        audio: "remove",
        frameRate: { mode: "preserve" },
        rateControl: { mode: profile === "main10-capped" ? "capped-crf" : "crf" },
        ladder: { mode: "custom", renditions: [{ height: 360 }] },
      }),
    );
    const directory = join(root, `${scene}-${profile}`);
    await mkdir(join(directory, "v0"), { recursive: true });
    const command = buildHlsCommand({
      inputPath,
      source,
      options,
      directory,
      audioAnalysis: "absent",
    });
    const argv = command.argv.map((argument) =>
      profile === "main8-crf"
        ? argument.replace("yuv420p10le", "yuv420p").replace("main10", "main")
        : argument,
    );
    const started = performance.now();
    await run(command.executable, argv, { maxBuffer: 8 * 1024 * 1024 });
    const encodeSeconds = (performance.now() - started) / 1000;
    const contents = await Effect.runPromise(
      finalizeHlsPackage(directory, `${scene}-${profile}`, options, false),
    );
    const metrics = await run(
      "ffmpeg",
      [
        "-hide_banner",
        "-i",
        join(directory, "v0/index.m3u8"),
        "-i",
        inputPath,
        "-lavfi",
        "[0:v]format=yuv420p,setpts=PTS-STARTPTS,split=2[a][c];[1:v]format=yuv420p,setpts=PTS-STARTPTS,split=2[b][d];[a][b]ssim[s];[c][d]psnr[p]",
        "-map",
        "[s]",
        "-map",
        "[p]",
        "-f",
        "null",
        "-",
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    const row = {
      scene,
      profile,
      encodeSeconds,
      crf: options.renditions[0]?.crf.h265,
      packageBytes: contents.packageBytes,
      peakBitsPerSecond: contents.renditions[0]?.bandwidth,
      averageBitsPerSecond: contents.renditions[0]?.averageBandwidth,
      ssim: Number(metrics.stderr.match(/All:([\d.]+)/)?.[1]),
      psnr: Number(metrics.stderr.match(/average:([\d.]+)/)?.[1]),
      maxVideoBitrateBps: options.renditions[0]?.maxVideoBitrateBps,
    };
    results.push(row);
    await writeFile(join(root, "results.json"), JSON.stringify(results, null, 2));
    process.stdout.write(`${JSON.stringify(row)}\n`);
  }
  await rm(inputPath);
}
