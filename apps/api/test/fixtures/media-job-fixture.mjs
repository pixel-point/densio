#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

const defaults = {
  audio: undefined,
  duration: 6,
  frameCount: 300,
  frameTimestamp: 1.25,
  height: 360,
  width: 640,
};
const argv = process.argv.slice(2);
const inputIndex = argv.indexOf("-i");
const inputPath = inputIndex < 0 ? argv.at(-1) : argv[inputIndex + 1];
const source = await readSource(inputPath);

if (argv.includes("-show_format") && argv.includes("-show_streams")) {
  const streams = [
    {
      avg_frame_rate: source.frameRate ?? "24/1",
      codec_name: "h264",
      codec_type: "video",
      height: source.height,
      index: 0,
      width: source.width,
    },
    ...(source.audio === undefined ? [] : [{ codec_type: "audio", index: 1, codec_name: "aac" }]),
  ];
  process.stdout.write(JSON.stringify({ format: { duration: String(source.duration) }, streams }));
  process.exit(0);
}

if (argv.includes("-show_frames")) {
  process.stdout.write(
    JSON.stringify({
      frames: Array.from({ length: source.frameCount }, () => ({
        best_effort_timestamp_time: String(source.frameTimestamp),
      })),
    }),
  );
  process.exit(0);
}

if (argv.includes("-af") && argv.includes("null")) {
  process.stdout.write(`lavfi.astats.Overall.Peak_level=${source.audio ?? "-inf"}\n`);
  process.exit(0);
}

const metricFilterIndex = argv.indexOf("-lavfi");
const metricFilter = metricFilterIndex < 0 ? undefined : argv[metricFilterIndex + 1];
if (metricFilter?.startsWith("ssim=") || metricFilter?.startsWith("psnr=")) {
  const statsPath = metricFilter.slice(metricFilter.indexOf("stats_file=") + "stats_file=".length);
  await mkdir(dirname(statsPath), { recursive: true });
  await writeFile(statsPath, "metric-stats");
  const crf = Number(/crf-(\d+)/.exec(inputPath ?? "")?.[1] ?? 0);
  if (metricFilter.startsWith("ssim=")) {
    process.stderr.write(`SSIM Y:1 U:1 V:1 All:${1 - crf / 1000} (20)`);
  } else {
    const average = 50 - crf / 2;
    process.stderr.write(`PSNR y:${average} u:${average} v:${average} average:${average}`);
  }
  process.exit(0);
}

const outputPath = argv.at(-1);
if (outputPath === undefined) process.exit(2);

if (outputPath.includes("%06d")) {
  await mkdir(dirname(outputPath), { recursive: true });
  await Promise.all(
    [1, 2, 3].map((number) =>
      writeFile(outputPath.replace("%06d", String(number).padStart(6, "0")), `frame-${number}`),
    ),
  );
  process.exit(0);
}

await mkdir(dirname(outputPath), { recursive: true });
const crfIndex = argv.indexOf("-crf");
const crf = crfIndex < 0 ? undefined : Number(argv[crfIndex + 1]);
const content =
  crf === undefined ? `still:${basename(inputPath ?? "unknown")}` : Buffer.alloc(crf * 10, crf);
await writeFile(outputPath, content);

if (source.failCodec !== undefined && outputPath.includes(source.failCodec)) {
  process.stderr.write("\u001b[31mdeterministic media job failure\u001b[0m\u0000");
  process.exit(9);
}

async function readSource(path) {
  if (path === undefined) return defaults;
  try {
    return { ...defaults, ...JSON.parse(await readFile(path, "utf8")) };
  } catch {
    return defaults;
  }
}
