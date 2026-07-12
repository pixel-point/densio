import { JobStatusSchema, successEnvelope, type ProblemDetails } from "@ffmpeg-api/shared";
import { Schema } from "effect";

import { authorizationHeaders } from "./authentication.ts";
import { numberFlag, parseCommandArguments } from "./command-options.ts";
import { CliProblemError, CliUsageError } from "./cli-errors.ts";
import { requestJson } from "./http-client.ts";
import { emitProgress, emitSuccess, formatJobStatus } from "./render.ts";
import { CLI_EXIT_CODES } from "./output.ts";
import { pollUntilComplete } from "./polling.ts";
import type { CliRuntime } from "./runtime.ts";

const decodeJobStatus = Schema.decodeUnknownEffect(successEnvelope(JobStatusSchema));

export const waitForJob = async (
  runtime: CliRuntime,
  jobId: string,
  statusUrl: string,
  timeoutSeconds?: number,
) => {
  const startedAt = runtime.now();
  const headers = await authorizationHeaders(runtime);
  return pollUntilComplete({
    ...(timeoutSeconds === undefined ? {} : { deadlineAt: startedAt + timeoutSeconds * 1_000 }),
    decide: (response) => {
      emitProgress(runtime, response.data);
      if (response.data.state === "succeeded") return { kind: "complete", value: response };
      if (response.data.state === "failed") throw new CliProblemError(response.data.problem);
      if (response.data.state === "canceled") {
        throw new CliProblemError(response.data.problem ?? terminalProblem("canceled", jobId));
      }
      if (response.data.state === "expired") {
        throw new CliProblemError(terminalProblem("expired", jobId));
      }
      return { delayMilliseconds: 1_000, kind: "pending" };
    },
    initialDelayMilliseconds: 0,
    interruptedError: () => interruptedJobError(jobId),
    isRetryableFailure: isRetryablePollFailure,
    poll: () => requestJson(runtime, statusUrl, { headers, method: "GET" }, decodeJobStatus),
    runtime,
    timeoutError: () => new CliProblemError(timeoutProblem(jobId), CLI_EXIT_CODES.network),
  });
};

export const runJobsCommand = async (argv: ReadonlyArray<string>, runtime: CliRuntime) => {
  const parsed = parseCommandArguments(argv, new Set(["--timeout"]), new Set());
  const [command, jobId, ...extra] = parsed.positionals;
  if (
    (command !== "get" && command !== "wait" && command !== "cancel") ||
    jobId === undefined ||
    extra.length > 0
  ) {
    throw new CliUsageError("jobs requires get, wait, or cancel followed by a job ID.");
  }
  const headers = await authorizationHeaders(runtime);
  const path = `/v1/jobs/${encodeURIComponent(jobId)}${command === "cancel" ? "/cancel" : ""}`;
  if (command === "wait") {
    const timeoutSeconds = numberFlag(parsed, "--timeout");
    if (timeoutSeconds !== undefined && timeoutSeconds <= 0) {
      throw new CliUsageError("--timeout must be positive.");
    }
    const response = await waitForJob(runtime, jobId, path, timeoutSeconds);
    emitSuccess(runtime, response, formatJobStatus(response.data));
    return;
  }
  const response = await requestJson(
    runtime,
    path,
    { headers, method: command === "cancel" ? "POST" : "GET" },
    decodeJobStatus,
  );
  emitSuccess(runtime, response, formatJobStatus(response.data));
};

const terminalProblem = (state: "canceled" | "expired", jobId: string): ProblemDetails => ({
  code: state === "canceled" ? "JOB_CANCELED" : "JOB_EXPIRED",
  correlationId: "local",
  detail: `Job ${jobId} is ${state}.`,
  jobId,
  retryable: false,
  schemaVersion: 1,
  status: state === "canceled" ? 409 : 410,
  suggestedAction: "Create a new media job if another result is required.",
  title: `Job ${state}`,
  type: "about:blank",
});

const timeoutProblem = (jobId: string): ProblemDetails => ({
  code: "CLI_WAIT_TIMEOUT",
  correlationId: "local",
  detail: `Timed out waiting for job ${jobId}.`,
  jobId,
  retryable: true,
  schemaVersion: 1,
  status: 504,
  suggestedAction: `Resume with ffmpeg-api jobs wait ${jobId}.`,
  title: "Wait timed out",
  type: "about:blank",
});

const interruptedJobError = (jobId: string) =>
  new CliProblemError(
    {
      ...timeoutProblem(jobId),
      code: "CLI_INTERRUPTED",
      detail: `Stopped waiting for job ${jobId}; the server job is still running.`,
      status: 499,
      title: "Wait interrupted",
    },
    130,
  );

const isRetryablePollFailure = (cause: unknown) =>
  cause instanceof CliProblemError &&
  (cause.exitCode === CLI_EXIT_CODES.network || cause.problem.retryable);
