#!/usr/bin/env node

import { basename, dirname, join } from "node:path";
import { mkdir, readdir, writeFile } from "node:fs/promises";

const argv = process.argv.slice(2);
const executableMode = basename(process.argv[1]);
const outputPath = argv.at(-1);

if (outputPath === undefined) process.exit(2);

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
    process.stderr.write("deterministic workflow failure");
    process.exit(9);
  }
};

if (outputPath.includes("%06d")) {
  await writeExtractionFrames();
} else {
  await writeSingleOutput();
}
