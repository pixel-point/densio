import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect } from "vitest";
import { MEDIA_CODEC_POLICY } from "@densio/shared";
import { decodeArtifactMaterialization, decodeJobAccepted, decodeJobStatus } from "./contracts.ts";
import { probeVideo, runCli } from "./driver.ts";

export const verifyDirectHls = async (
  apiUrl: string,
  credentialsPath: string,
  sourceId: string,
  directory: string,
) => {
  const outputDirectory = join(await realpath(directory), "hls");
  const command = [
    "jobs",
    "create",
    sourceId,
    "hls",
    "--idempotency-key",
    "hls-golden",
    "--client-reference",
    "hls-golden",
    "--no-wait",
  ];
  const accepted = decodeJobAccepted(
    JSON.parse((await runCli(apiUrl, credentialsPath, command)).stdout),
  ).data;
  const completed = decodeArtifactMaterialization(
    JSON.parse(
      (
        await runCli(apiUrl, credentialsPath, [
          "jobs",
          "wait",
          accepted.jobId,
          "--output-dir",
          outputDirectory,
        ])
      ).stdout,
    ),
  ).data;
  expect(completed.job).toMatchObject({
    state: "succeeded",
    workflow: "hls",
    result: { kind: "hls", renditions: [{ crf: { h265: MEDIA_CODEC_POLICY.h265.defaultCrf } }] },
  });
  const archive = completed.files.find(({ filename }) => filename === "hls.zip");
  if (!archive) throw new Error("HLS returned no verified archive");
  const unpacked = join(outputDirectory, "package");
  await promisify(execFile)("unzip", ["-q", archive.path, "-d", unpacked]);
  expect(await readFile(join(unpacked, "master.m3u8"), "utf8")).toContain('CODECS="hvc1.');
  expect(await probeVideo(join(unpacked, "v0", "index.m3u8"))).toMatchObject({
    codec: "hevc",
    width: 64,
    height: 64,
  });
  const replay = decodeJobAccepted(
    JSON.parse((await runCli(apiUrl, credentialsPath, command)).stdout),
  ).data;
  expect(replay.jobId).toBe(accepted.jobId);
  const after = decodeJobStatus(
    JSON.parse((await runCli(apiUrl, credentialsPath, ["jobs", "get", accepted.jobId])).stdout),
  ).data;
  expect(after.state).toBe("succeeded");
  if (after.state !== "succeeded" || completed.job.state !== "succeeded")
    throw new Error("HLS did not complete");
  expect(after.receipt).toEqual(completed.job.receipt);
  await runCli(apiUrl, credentialsPath, ["artifacts", "delete", archive.artifactId]);
};
