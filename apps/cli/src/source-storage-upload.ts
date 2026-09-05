import { openAsBlob } from "node:fs";
import {
  SourceUploadSessionResponseSchema,
  SourceUploadPartsResponseSchema,
  type PreparedSourceStatus,
} from "@densio/shared";
import { CliProblemError, invalidResponseError, networkError } from "./cli-errors.ts";
import { jsonRequest } from "./http-client.ts";
import { organizationResponse } from "./organization-client.ts";
import { organizationPath, type OrganizationRuntime } from "./organization-context.ts";
import { organizationResponses } from "./organization-responses.ts";
import { pollUntilComplete } from "./polling.ts";
import type { CliRuntime } from "./runtime.ts";

const sessionResponse = organizationResponse(SourceUploadSessionResponseSchema, (value) => [
  value,
  value.session,
]);
const partsResponse = organizationResponse(SourceUploadPartsResponseSchema, (value) => [value]);
type DirectAction = (typeof SourceUploadPartsResponseSchema.Type.actions)[number];

export const uploadCustomerSource = async (
  runtime: OrganizationRuntime,
  inputPath: string,
  source: Extract<PreparedSourceStatus, { state: "awaiting-upload" }>,
) => {
  const path = organizationPath(
    runtime,
    `/sources/${encodeURIComponent(source.sourceId)}/storage-upload`,
  );
  const session = await pollSourceStorage(
    runtime,
    source,
    async (signal) =>
      runtime.organizationClient.request(path, { method: "GET", signal }, sessionResponse),
    (response) => {
      if (response.data.session.sourceId !== source.sourceId) throw invalidResponseError();
      rejectUploadFailure(
        response.data.session.state,
        source.sourceId,
        response.data.session.errorCode,
      );
      return response.data.session.state !== "creating";
    },
  );
  if (session.data.session.state === "uploading") {
    const blob = await openAsBlob(inputPath, { type: "application/octet-stream" });
    if (blob.size !== source.declaredBytes)
      throw networkError("The source file changed after upload creation.");
    const uploaded = new Set(session.data.session.uploadedParts.map((part) => part.partNumber));
    const pending = Array.from(
      { length: session.data.session.totalParts },
      (_, index) => index + 1,
    ).filter((part) => !uploaded.has(part));
    for (let index = 0; index < pending.length; index += 4) {
      const partNumbers = pending.slice(index, index + 4);
      const actions = await runtime.organizationClient.request(
        `${path}/parts`,
        jsonRequest("POST", { partNumbers }),
        partsResponse,
      );
      if (
        actions.data.sourceId !== source.sourceId ||
        actions.data.actions.length !== partNumbers.length ||
        actions.data.actions.some((action) => !partNumbers.includes(action.partNumber))
      )
        throw invalidResponseError();
      await uploadDirectParts(runtime, blob, session.data.session.partSize, actions.data.actions);
    }
    await runtime.organizationClient.request(
      `${path}/commit`,
      jsonRequest("POST", {}),
      sessionResponse,
    );
  }
  return pollSourceStorage(
    runtime,
    source,
    async (signal) => {
      const status = await runtime.organizationClient.request(
        organizationPath(runtime, `/sources/${encodeURIComponent(source.sourceId)}`),
        { method: "GET", signal },
        organizationResponses.PreparedSourceStatus,
      );
      if (status.data.sourceId !== source.sourceId) throw invalidResponseError();
      if (status.data.state === "awaiting-upload") {
        const current = await runtime.organizationClient.request(
          path,
          { method: "GET", signal },
          sessionResponse,
        );
        rejectUploadFailure(
          current.data.session.state,
          source.sourceId,
          current.data.session.errorCode,
        );
      }
      return status;
    },
    (response) => {
      if (response.data.state === "failed") throw new CliProblemError(response.data.problem);
      rejectUploadFailure(response.data.state, source.sourceId);
      return response.data.state === "ready";
    },
  );
};

export const uploadDirectParts = async (
  runtime: CliRuntime,
  blob: Blob,
  partSize: number,
  actions: readonly DirectAction[],
) => {
  if (
    !Number.isSafeInteger(partSize) ||
    partSize !== 64 * 1024 * 1024 ||
    actions.length > 4 ||
    new Set(actions.map((action) => action.partNumber)).size !== actions.length
  )
    throw invalidResponseError();
  await Promise.all(
    actions.map(async (action) => {
      const url = new URL(action.url);
      const start = (action.partNumber - 1) * partSize;
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        start < 0 ||
        start >= blob.size ||
        action.bytes !== Math.min(partSize, blob.size - start) ||
        action.headers["content-length"] !== String(action.bytes)
      )
        throw invalidResponseError();
      const response = await runtime
        .fetch(url.toString(), {
          method: "PUT",
          body: blob.slice(start, start + action.bytes),
          headers: action.headers,
          redirect: "error",
          credentials: "omit",
          ...(runtime.signal ? { signal: runtime.signal } : {}),
        })
        .catch(() => {
          throw networkError(
            "The direct storage upload was interrupted. Retry inspect with the same idempotency key and file to resume.",
          );
        });
      await response.body?.cancel();
      if (!response.ok)
        throw networkError(
          "The storage provider rejected an upload part. Retry inspect with the same idempotency key and file to resume.",
        );
    }),
  );
};
const pollSourceStorage = <Value>(
  runtime: CliRuntime,
  source: PreparedSourceStatus,
  poll: (signal: AbortSignal) => Promise<Value>,
  complete: (value: Value) => boolean,
) =>
  pollUntilComplete({
    runtime,
    initialDelayMilliseconds: 0,
    deadlineAt: Date.parse(source.expiresAt),
    poll,
    interruptedError: () => uploadProblem("CLI_INTERRUPTED", source.sourceId),
    timeoutError: () => uploadProblem("CLI_WAIT_TIMEOUT", source.sourceId),
    isRetryableFailure: (error) =>
      error instanceof CliProblemError && (error.exitCode === 6 || error.problem.retryable),
    decide: (value) =>
      complete(value) ? { kind: "complete", value } : { kind: "pending", delayMilliseconds: 1000 },
  });
const rejectUploadFailure = (state: string, sourceId: string, code?: string) => {
  if (["failed", "expired", "deleted"].includes(state))
    throw uploadProblem(code ?? "STORAGE_ACCESS_EXPIRED", sourceId);
};
const uploadProblem = (code: string, sourceId: string) =>
  new CliProblemError(
    {
      schemaVersion: 1,
      code,
      correlationId: "local",
      type: "about:blank",
      title: "Source upload needs attention",
      detail: `Source ${sourceId} did not finish preparing.`,
      status: code === "CLI_INTERRUPTED" ? 499 : 409,
      retryable: false,
      suggestedAction: `Inspect sources get ${sourceId}; resume inspect with the original file and idempotency key if the upload remains open.`,
    },
    code === "CLI_INTERRUPTED" ? 130 : code === "CLI_WAIT_TIMEOUT" ? 6 : 5,
  );
