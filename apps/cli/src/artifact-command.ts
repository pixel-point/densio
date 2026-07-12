import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { link, mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

import { Predicate } from "effect";

import { parseCommandArguments, requireSinglePositional, singleFlag } from "./command-options.ts";
import {
  artifactHashMismatchError,
  artifactDestinationExistsError,
  CliProblemError,
  CliUsageError,
  networkError,
} from "./cli-errors.ts";
import { decodeProblemResponse } from "./http-client.ts";
import { emitSuccess } from "./render.ts";
import type { CliRuntime } from "./runtime.ts";

export const runArtifactCommand = async (argv: ReadonlyArray<string>, runtime: CliRuntime) => {
  const [command, ...argumentsRemaining] = argv;
  if (command !== "download") throw new CliUsageError("artifacts requires download.");
  const parsed = parseCommandArguments(
    argumentsRemaining,
    new Set(["--output", "--sha256"]),
    new Set(["--force"]),
  );
  const artifact = requireSinglePositional(
    parsed,
    "artifacts download requires one signed HTTP(S) download URL.",
  );
  const outputPath = requiredFlag(parsed, "--output");
  const expectedSha256 = requiredFlag(parsed, "--sha256").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new CliUsageError("--sha256 requires a 64-character hexadecimal digest.");
  }
  const target = artifactTarget(artifact);
  const response = await runtime
    .fetch(target, {
      method: "GET",
      ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
    })
    .catch(() => Promise.reject(networkError("The artifact download could not be started.")));
  if (!response.ok) throw new CliProblemError(await decodeProblemResponse(response));
  if (response.body === null) throw networkError("The artifact response has no body.");

  const downloaded = await streamArtifact(response.body, outputPath);
  if (downloaded.sha256 !== expectedSha256) {
    await rm(downloaded.temporaryPath, { force: true });
    throw artifactHashMismatchError();
  }
  await publishVerifiedArtifact(
    downloaded.temporaryPath,
    outputPath,
    parsed.switches.has("--force"),
  );
  emitSuccess(
    runtime,
    {
      correlationId: "local",
      data: { bytes: downloaded.bytes, path: outputPath, sha256: downloaded.sha256 },
      ok: true,
      schemaVersion: 1,
    },
    `Downloaded ${outputPath} (${downloaded.bytes} bytes).\n`,
  );
};

const publishVerifiedArtifact = async (
  temporaryPath: string,
  outputPath: string,
  force: boolean,
) => {
  if (force) {
    await rename(temporaryPath, outputPath).catch(async () => {
      await rm(temporaryPath, { force: true });
      throw networkError("The verified artifact could not replace the local output.");
    });
    return;
  }
  await link(temporaryPath, outputPath).catch(async (cause: unknown) => {
    await rm(temporaryPath, { force: true });
    if (Predicate.hasProperty(cause, "code") && cause.code === "EEXIST") {
      throw artifactDestinationExistsError();
    }
    throw networkError("The verified artifact could not be published locally.");
  });
  await rm(temporaryPath, { force: true }).catch(() =>
    Promise.reject(networkError("The published artifact temporary file could not be removed.")),
  );
};

const streamArtifact = async (body: ReadableStream<Uint8Array>, outputPath: string) => {
  const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
  const digest = createHash("sha256");
  let bytes = 0;
  const hashingStream = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      bytes += chunk.length;
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await pipeline(
    Readable.fromWeb(body),
    hashingStream,
    createWriteStream(temporaryPath, { flags: "wx" }),
  ).catch(async () => {
    await rm(temporaryPath, { force: true });
    throw networkError("The artifact download was interrupted.");
  });
  return { bytes, sha256: digest.digest("hex"), temporaryPath } as const;
};

const artifactTarget = (artifact: string) => {
  if (!URL.canParse(artifact)) {
    throw new CliUsageError("Artifact download requires a signed HTTP(S) download URL.");
  }
  const url = new URL(artifact);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliUsageError("Artifact download requires a signed HTTP(S) download URL.");
  }
  return url.toString();
};

const requiredFlag = (parsed: Parameters<typeof singleFlag>[0], name: string) => {
  const value = singleFlag(parsed, name);
  if (value === undefined) throw new CliUsageError(`${name} is required.`);
  return value;
};
