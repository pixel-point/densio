import { uploadCustomerSource } from "./source-storage-upload.ts";
import { organizationResponses } from "./organization-responses.ts";
import type { OrganizationRuntime } from "./organization-context.ts";
import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";

import {
  PreparedSourceCreateRequestSchema,
  PreparedSourceListQuerySchema,
  type PreparedSourceStatus,
  type SuccessEnvelope,
} from "@densio/shared";

import {
  decodeCliOptions,
  numberFlag,
  requireSinglePositional,
  singleFlag,
} from "./command-options.ts";
import { CliUsageError, invalidResponseError } from "./cli-errors.ts";
import { parseCatalogCommand } from "./command-catalog.ts";
import { jsonRequest } from "./http-client.ts";
import { emitStatusEvent, emitSuccess } from "./render.ts";
import type { CliRuntime } from "./runtime.ts";
import { organizationPath, selectOrganization } from "./organization-context.ts";

const decodeCreated = organizationResponses.PreparedSourceCreateResponse;
const decodeStatus = organizationResponses.PreparedSourceStatus;
const decodeDeletion = organizationResponses.PreparedSourceDeletionReceipt;

export const runInspectCommand = async (
  argv: ReadonlyArray<string>,
  unscopedRuntime: CliRuntime,
) => {
  const parsed = parseCatalogCommand("inspect", argv);
  const inputPath = requireSinglePositional(parsed, "inspect requires exactly one video path.");
  const input = await stat(inputPath).catch(() =>
    Promise.reject(new CliUsageError(`Video file is not readable: ${inputPath}.`)),
  );
  if (!input.isFile()) throw new CliUsageError("The media input must be a regular file.");
  const runtime = await selectOrganization(unscopedRuntime);
  const request = decodeCliOptions(
    PreparedSourceCreateRequestSchema,
    {
      bytes: input.size,
      filename: basename(inputPath),
      ...(singleFlag(parsed, "--upload-storage")
        ? { uploadStorage: singleFlag(parsed, "--upload-storage") }
        : {}),
    },
    "inspect",
  );
  const idempotencyKey = singleFlag(parsed, "--idempotency-key");
  const created = await runtime.organizationClient.request(
    organizationPath(runtime, "/sources"),
    jsonRequest(
      "POST",
      request,
      idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey },
    ),
    decodeCreated,
  );
  const statusUrl = `${organizationPath(runtime)}/sources/${encodeURIComponent(created.data.source.sourceId)}`;
  emitStatusEvent(
    runtime,
    {
      resumeCommand: `densio --org ${created.data.source.organizationId} sources get ${created.data.source.sourceId}`,
      organizationId: created.data.source.organizationId,
      sourceId: created.data.source.sourceId,
      statusUrl: new URL(statusUrl, `${runtime.apiUrl}/`).toString(),
      type: "source-created",
    },
    `Source ${created.data.source.sourceId} created; resume with densio --org ${created.data.source.organizationId} sources get ${created.data.source.sourceId}.\n`,
  );
  const response =
    created.data.source.state === "awaiting-upload"
      ? await uploadSource(runtime, inputPath, input.size, created.data.source)
      : sourceEnvelope(created, created.data.source);
  emitSuccess(runtime, response, formatSourceStatus(response.data));
};

export const runSourcesCommand = async (
  argv: ReadonlyArray<string>,
  unscopedRuntime: CliRuntime,
) => {
  const [command, ...argumentsRemaining] = argv;
  if (command === "list") return runSourceList(argumentsRemaining, unscopedRuntime);
  if (command !== "get" && command !== "delete") {
    throw new CliUsageError("sources requires list, get, or delete.");
  }
  const parsed = parseCatalogCommand(`sources ${command}`, argumentsRemaining);
  const sourceId = requireSinglePositional(parsed, `sources ${command} requires one source ID.`);
  const runtime = await selectOrganization(unscopedRuntime);
  const path = `${organizationPath(runtime)}/sources/${encodeURIComponent(sourceId)}`;
  if (command === "delete") {
    const response = await runtime.organizationClient.request(
      path,
      { method: "DELETE" },
      decodeDeletion,
    );
    emitSuccess(runtime, response, `Source ${response.data.sourceId} deleted.\n`);
    return;
  }
  const response = await runtime.organizationClient.request(path, { method: "GET" }, decodeStatus);
  emitSuccess(runtime, response, formatSourceStatus(response.data));
};

const runSourceList = async (argv: ReadonlyArray<string>, unscopedRuntime: CliRuntime) => {
  const parsed = parseCatalogCommand("sources list", argv);
  if (parsed.positionals.length > 0) throw new CliUsageError("sources list accepts only filters.");
  const query = decodeCliOptions(
    PreparedSourceListQuerySchema,
    Object.fromEntries(
      Object.entries({
        state: singleFlag(parsed, "--state"),
        since: singleFlag(parsed, "--since"),
        cursor: singleFlag(parsed, "--cursor"),
        limit: numberFlag(parsed, "--limit"),
      }).filter(([, value]) => value !== undefined),
    ),
    "sources list",
  );
  const parameters = new URLSearchParams(
    Object.entries(query).map(([key, value]): [string, string] => [key, String(value)]),
  );
  const runtime = await selectOrganization(unscopedRuntime);
  const response = await runtime.organizationClient.request(
    `${organizationPath(runtime)}/sources${parameters.size === 0 ? "" : `?${parameters}`}`,
    { method: "GET" },
    organizationResponses.PreparedSourceListResponse,
  );
  emitSuccess(
    runtime,
    response,
    response.data.sources.length === 0
      ? "No sources found.\n"
      : response.data.sources.map(formatSourceStatus).join(""),
  );
};

const uploadSource = async (
  runtime: OrganizationRuntime,
  inputPath: string,
  bytes: number,
  source: Extract<PreparedSourceStatus, { readonly state: "awaiting-upload" }>,
) => {
  if ("transport" in source.upload && source.upload.transport === "s3-multipart")
    return uploadCustomerSource(runtime, inputPath, source);
  const blob = await openAsBlob(inputPath, { type: "application/octet-stream" });
  const response = await runtime.organizationClient.request(
    source.upload.url,
    {
      body: blob,
      headers: { "content-length": String(bytes) },
      method: "PUT",
    },
    decodeStatus,
  );
  if (
    response.data.sourceId !== source.sourceId ||
    ("verifiedBytes" in response.data && response.data.verifiedBytes !== bytes)
  ) {
    throw invalidResponseError();
  }
  return response;
};

const sourceEnvelope = (
  envelope: SuccessEnvelope<unknown>,
  source: PreparedSourceStatus,
): SuccessEnvelope<PreparedSourceStatus> => ({
  correlationId: envelope.correlationId,
  data: source,
  ok: true,
  schemaVersion: 1,
});

const formatSourceStatus = (source: PreparedSourceStatus) => {
  if (source.state !== "ready") return `${source.sourceId} ${source.state}.\n`;
  const { displayDimensions, durationSeconds, frameRate } = source.inspection;
  return [
    `${source.sourceId} ready.`,
    `${displayDimensions.width}x${displayDimensions.height}, ${durationSeconds}s, ${frameRate.framesPerSecond.toFixed(2)} fps.`,
    `SHA-256 ${source.sha256}`,
    "",
  ].join("\n");
};
