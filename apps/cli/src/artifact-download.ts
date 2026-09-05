import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  artifactDownloadInterruptedError,
  artifactHashMismatchError,
  artifactSizeMismatchError,
  CliProblemError,
  CliUsageError,
  networkError,
} from "./cli-errors.ts";
import { decodeProblemResponse } from "./http-client.ts";
import type { CliRuntime } from "./runtime.ts";

interface ArtifactExpectation {
  readonly bytes?: number;
  readonly sha256: string;
}

export const stageVerifiedArtifact = async (
  runtime: CliRuntime,
  downloadUrl: string,
  outputPath: string,
  expectation: ArtifactExpectation,
) => {
  const response = await runtime
    .fetch(httpTarget(downloadUrl), {
      method: "GET",
      ...(runtime.signal === undefined ? {} : { signal: runtime.signal }),
    })
    .catch(() =>
      Promise.reject(
        runtime.signal?.aborted === true
          ? artifactDownloadInterruptedError()
          : networkError("The artifact download could not be started."),
      ),
    );
  if (!response.ok) throw new CliProblemError(await decodeProblemResponse(response));
  if (response.body === null) throw networkError("The artifact response has no body.");
  const downloaded = await streamArtifact(response.body, outputPath, runtime.signal);
  if (expectation.bytes !== undefined && downloaded.bytes !== expectation.bytes) {
    await rm(downloaded.temporaryPath, { force: true });
    throw artifactSizeMismatchError();
  }
  if (downloaded.sha256 !== expectation.sha256) {
    await rm(downloaded.temporaryPath, { force: true });
    throw artifactHashMismatchError();
  }
  return downloaded;
};

export const httpTarget = (artifact: string) => {
  if (!URL.canParse(artifact)) {
    throw new CliUsageError("Artifact download requires an artifact ID or signed HTTP(S) URL.");
  }
  const url = new URL(artifact);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliUsageError("Artifact download requires an artifact ID or signed HTTP(S) URL.");
  }
  return url.toString();
};

const streamArtifact = async (
  body: ReadableStream<Uint8Array>,
  outputPath: string,
  signal: AbortSignal | undefined,
) => {
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
    if (signal?.aborted === true) throw artifactDownloadInterruptedError();
    throw networkError("The artifact download was interrupted.");
  });
  return { bytes, sha256: digest.digest("hex"), temporaryPath } as const;
};
