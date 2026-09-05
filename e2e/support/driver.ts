import { execFile, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFilePromise = promisify(execFile);
const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const cliPath = join(repositoryRoot, "apps/cli/dist/index.js");
const fixturePath = join(repositoryRoot, "e2e/fixtures/tiny-video.mp4.base64");

export const runCli = async (
  apiUrl: string,
  credentialsPath: string,
  command: ReadonlyArray<string>,
  timeout = 120_000,
) => {
  const result = await execFilePromise(
    process.execPath,
    [cliPath, "--json", "--api-url", apiUrl, "--credentials", credentialsPath, ...command],
    { timeout },
  );
  return { stderr: result.stderr, stdout: result.stdout };
};

export const startCli = (
  apiUrl: string,
  credentialsPath: string,
  command: ReadonlyArray<string>,
  timeout = 120_000,
) => {
  const child = spawn(
    process.execPath,
    [cliPath, "--json", "--api-url", apiUrl, "--credentials", credentialsPath, ...command],
    { signal: AbortSignal.timeout(timeout), stdio: ["ignore", "pipe", "pipe"] },
  );
  const stdout: Array<Buffer> = [];
  const stderr: Array<Buffer> = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  return {
    result: new Promise<{
      readonly code: number | null;
      readonly stderr: string;
      readonly stdout: string;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) =>
        resolve({
          code,
          stderr: Buffer.concat(stderr).toString(),
          stdout: Buffer.concat(stdout).toString(),
        }),
      );
    }),
    stop: () => child.kill(),
  };
};

export const writeVideoFixture = async (directory: string) => {
  const path = join(directory, "tiny-video.mp4");
  const encoded = (await readFile(fixturePath, "utf8")).replace(/\s/gu, "");
  await writeFile(path, Buffer.from(encoded, "base64"));
  return path;
};

export const probeVideo = async (path: string) => {
  const result = await execFilePromise("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_name,width,height,avg_frame_rate:format=duration",
    "-of",
    "json",
    path,
  ]);
  const output = JSON.parse(result.stdout) as {
    readonly format: { readonly duration: string };
    readonly streams: ReadonlyArray<{
      readonly avg_frame_rate?: string;
      readonly codec_name?: string;
      readonly height?: number;
      readonly width?: number;
    }>;
  };
  const stream = output.streams[0];
  if (stream === undefined) throw new Error("FFprobe found no video stream.");
  return {
    codec: stream.codec_name,
    durationSeconds: Number(output.format.duration),
    frameRate: stream.avg_frame_rate,
    height: stream.height,
    width: stream.width,
  };
};
