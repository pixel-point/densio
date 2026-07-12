import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";

import {
  CompressionJobRequestSchema,
  ExtractImagesJobRequestSchema,
  JobCreatedResponseSchema,
  QualityComparisonJobRequestSchema,
  UploadCompletedResponseSchema,
  successEnvelope,
  type JobCreatedResponse,
  type SuccessEnvelope,
} from "@ffmpeg-api/shared";
import { Schema } from "effect";

import { authorizationHeaders } from "./authentication.ts";
import { CliUsageError, invalidResponseError } from "./cli-errors.ts";
import { jsonRequest, requestJson } from "./http-client.ts";
import { waitForJob } from "./job-commands.ts";
import {
  parseComparisonCommand,
  parseCompressionCommand,
  parseExtractionCommand,
  type ParsedMediaCommand,
} from "./media-options.ts";
import { decodeCliOptions } from "./command-options.ts";
import { emitSuccess, formatJobStatus } from "./render.ts";
import type { CliRuntime } from "./runtime.ts";

const decodeJobCreated = Schema.decodeUnknownEffect(successEnvelope(JobCreatedResponseSchema));
const decodeUploadCompleted = Schema.decodeUnknownEffect(
  successEnvelope(UploadCompletedResponseSchema),
);

export const runMediaCommand = async (
  command: "compress" | "extract-images" | "compare-quality",
  argv: ReadonlyArray<string>,
  runtime: CliRuntime,
) => {
  const parsed = parseMediaCommand(command, argv);
  const input = await stat(parsed.inputPath).catch(() =>
    Promise.reject(new CliUsageError(`Video file is not readable: ${parsed.inputPath}.`)),
  );
  if (!input.isFile()) throw new CliUsageError("The media input must be a regular file.");
  const headers = await authorizationHeaders(runtime);
  const creationRequest = mediaCreationRequest(command, {
    options: parsed.options,
    source: { bytes: input.size, filename: basename(parsed.inputPath) },
  });
  const response = await requestJson(
    runtime,
    `/v1/${command}`,
    jsonRequest("POST", creationRequest, {
      ...headers,
      ...(parsed.idempotencyKey === undefined ? {} : { "idempotency-key": parsed.idempotencyKey }),
    }),
    decodeJobCreated,
  );
  const blob = await openAsBlob(parsed.inputPath, { type: "application/octet-stream" });
  const uploaded = await requestJson(
    runtime,
    response.data.upload.url,
    {
      body: blob,
      headers: { ...headers, "content-length": String(input.size) },
      method: "PUT",
    },
    decodeUploadCompleted,
  );
  if (uploaded.data.jobId !== response.data.jobId || uploaded.data.bytes !== input.size) {
    throw invalidResponseError();
  }
  if (parsed.noWait) {
    emitSuccess(runtime, resumeEnvelope(response), `Job ${response.data.jobId} uploaded.\n`);
    return;
  }
  const status = await waitForJob(
    runtime,
    response.data.jobId,
    response.data.statusUrl,
    parsed.timeoutSeconds,
  );
  emitSuccess(runtime, status, formatJobStatus(status.data));
};

const mediaCreationRequest = (
  command: "compress" | "extract-images" | "compare-quality",
  input: unknown,
) => {
  if (command === "compress") return decodeCliOptions(CompressionJobRequestSchema, input, command);
  if (command === "extract-images") {
    return decodeCliOptions(ExtractImagesJobRequestSchema, input, command);
  }
  return decodeCliOptions(QualityComparisonJobRequestSchema, input, command);
};

const parseMediaCommand = (
  command: "compress" | "extract-images" | "compare-quality",
  argv: ReadonlyArray<string>,
): ParsedMediaCommand<unknown> => {
  if (command === "compress") return parseCompressionCommand(argv);
  if (command === "extract-images") return parseExtractionCommand(argv);
  return parseComparisonCommand(argv);
};

const resumeEnvelope = (response: SuccessEnvelope<JobCreatedResponse>) => ({
  correlationId: response.correlationId,
  data: {
    jobId: response.data.jobId,
    resumeCommand: `ffmpeg-api jobs wait ${response.data.jobId}`,
    statusUrl: response.data.statusUrl,
  },
  ok: true as const,
  schemaVersion: 1 as const,
});
