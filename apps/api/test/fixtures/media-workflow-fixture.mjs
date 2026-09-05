#!/usr/bin/env node

import { basename, dirname, join } from "node:path";
import { access, mkdir, readdir, writeFile } from "node:fs/promises";

const argv = process.argv.slice(2);
const executableMode = basename(process.argv[1]);
const outputPath = argv.at(-1);

if (outputPath === undefined) process.exit(2);

const writeMetricOutput = async () => {
  const filterIndex = argv.indexOf("-lavfi");
  const filter = filterIndex < 0 ? undefined : argv[filterIndex + 1];
  if (filter === undefined || (!filter.startsWith("ssim=") && !filter.startsWith("psnr="))) {
    return false;
  }
  const statsPath = filter.slice(filter.indexOf("stats_file=") + "stats_file=".length);
  await mkdir(dirname(statsPath), { recursive: true });
  await writeFile(statsPath, "metric-stats");
  if (executableMode.includes("malformed-metrics")) {
    process.stderr.write("deterministic malformed metric output");
    return true;
  }

  const inputIndex = argv.indexOf("-i");
  const previewPath = inputIndex < 0 ? "" : argv[inputIndex + 1];
  if (executableMode.includes("require-preview-barrier")) {
    const previews = (await readdir(dirname(previewPath))).filter((name) =>
      name.startsWith("preview-"),
    );
    if (previews.length < 2) process.exit(11);
  }
  const crf = Number(/crf-(\d+)/.exec(previewPath)?.[1] ?? 0);
  if (filter.startsWith("ssim=")) {
    process.stderr.write(`SSIM Y:1 U:1 V:1 All:${1 - crf / 1000} (20)`);
    return true;
  }
  const average = executableMode.includes("perfect-metrics") ? "inf" : String(50 - crf / 2);
  process.stderr.write(`PSNR y:${average} u:${average} v:${average} average:${average}`);
  return true;
};

const writeExtractionFrames = async () => {
  const frameDirectory = dirname(outputPath);
  await mkdir(frameDirectory, { recursive: true });
  await Promise.all(
    [1, 2, 3].map((number) =>
      writeFile(outputPath.replace("%06d", String(number).padStart(6, "0")), `frame-${number}`),
    ),
  );

  if (executableMode.includes("archive-fail")) {
    await mkdir(join(dirname(frameDirectory), "extracted-images.zip"));
  }
  if (executableMode.includes("fail-extraction")) {
    process.stderr.write("deterministic extraction failure");
    process.exit(9);
  }
};

const writeSingleOutput = async () => {
  await mkdir(dirname(outputPath), { recursive: true });
  const inputIndex = argv.indexOf("-i");
  const inputPath = inputIndex < 0 ? undefined : argv[inputIndex + 1];
  const crfIndex = argv.indexOf("-crf");
  const crf = crfIndex < 0 ? undefined : Number(argv[crfIndex + 1]);

  if (executableMode.includes("require-concurrent-codecs") && outputPath.includes("compressed-")) {
    await waitForOutputPeers("compressed-", 2);
  }
  if (executableMode.includes("require-concurrent-previews") && outputPath.includes("preview-")) {
    await waitForOutputPeers("preview-", 2);
  }
  if (executableMode.includes("require-preview-barrier") && outputPath.includes("preview-h265-")) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (executableMode.includes("require-concurrent-previews") && outputPath.endsWith(".jpg")) {
    await access(inputPath);
  }

  if (executableMode.includes("require-two-previews") && outputPath.endsWith(".jpg")) {
    const previews = (await readdir(dirname(outputPath))).filter((name) =>
      name.startsWith("preview-"),
    );
    if (previews.length < 2) process.exit(8);
  }

  const content =
    crf === undefined ? `still:${basename(inputPath ?? "unknown")}` : Buffer.alloc(crf * 10, crf);
  await writeFile(outputPath, content);

  const shouldFailH265 = executableMode.includes("fail-h265") && outputPath.includes("h265");
  const shouldFailPreview =
    executableMode.includes("fail-preview") && outputPath.includes("preview-vp9-crf-40");
  if (shouldFailH265 || shouldFailPreview) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    process.stderr.write("deterministic workflow failure");
    process.exit(9);
  }
};

const waitForOutputPeers = async (prefix, count) => {
  const directory = dirname(outputPath);
  await writeFile(join(directory, `.started-${basename(outputPath)}`), "");
  const startedAt = Date.now();
  while (Date.now() - startedAt < 500) {
    const peers = (await readdir(directory)).filter((name) =>
      name.startsWith(`.started-${prefix}`),
    );
    if (peers.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  process.stderr.write("independent workflow commands did not overlap");
  process.exit(10);
};

if (await writeMetricOutput()) {
  process.exit(0);
} else if (outputPath.includes("%06d")) {
  await writeExtractionFrames();
} else {
  await writeSingleOutput();
}
