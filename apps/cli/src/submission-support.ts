import type { ExecutionPlanExecuteResponse, SuccessEnvelope } from "@densio/shared";
import { parseUntil } from "./storage-options.ts";
import { numberFlag, singleFlag } from "./command-options.ts";
import { CliUsageError } from "./cli-errors.ts";
import { materializeJobArtifacts } from "./artifact-materializer.ts";
import { waitForJob } from "./job-waiter.ts";
import { emitStatusEvent, emitSuccess, formatJobStatus } from "./render.ts";
import type { OrganizationRuntime } from "./organization-context.ts";
import type { CliRuntime } from "./runtime.ts";

export const finishSubmission = async (
  runtime: OrganizationRuntime,
  response: SuccessEnvelope<ExecutionPlanExecuteResponse>,
  parsed: ReturnType<typeof parseSubmissionControls>,
) => {
  if (parsed.noWait) {
    emitSuccess(runtime, resumeEnvelope(response), `Job ${response.data.jobId} queued.\n`);
    return;
  }
  emitAccepted(runtime, response);
  const status = await waitForJob(
    runtime,
    response.data.jobId,
    response.data.statusUrl,
    parsed.timeoutSeconds,
    "wait",
    parsed.until,
  );
  if (parsed.outputDirectory !== undefined && status.data.state === "succeeded") {
    const materialized = await materializeJobArtifacts(
      runtime,
      response.data.jobId,
      parsed.outputDirectory,
      parsed.force,
    );
    emitSuccess(
      runtime,
      materialized,
      `Materialized ${materialized.data.files.length} artifacts in ${materialized.data.outputDirectory}.\n`,
    );
    return;
  }
  emitSuccess(runtime, status, formatJobStatus(status.data));
};

export const parseSubmissionControls = (parsed: Parameters<typeof numberFlag>[0]) => {
  const timeoutSeconds = numberFlag(parsed, "--timeout");
  if (timeoutSeconds !== undefined && timeoutSeconds <= 0) {
    throw new CliUsageError("--timeout must be positive.");
  }
  const until = parseUntil(parsed);
  const noWait = parsed.switches.has("--no-wait");
  if (until && noWait) throw new CliUsageError("--until cannot be used with --no-wait.");
  const force = parsed.switches.has("--force");
  const outputDirectory = singleFlag(parsed, "--output-dir");
  if (noWait && outputDirectory !== undefined) {
    throw new CliUsageError("--output-dir cannot be used with --no-wait.");
  }
  if (force && outputDirectory === undefined) {
    throw new CliUsageError("--force requires --output-dir.");
  }
  return {
    ...(until === undefined ? {} : { until }),
    force,
    noWait,
    ...(outputDirectory === undefined ? {} : { outputDirectory }),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
  };
};

const emitAccepted = (
  runtime: CliRuntime,
  response: SuccessEnvelope<{
    readonly organizationId: string;
    readonly jobId: string;
    readonly statusUrl: string;
  }>,
) => {
  const resumeCommand = `densio --org ${response.data.organizationId} jobs wait ${response.data.jobId}`;
  emitStatusEvent(
    runtime,
    {
      organizationId: response.data.organizationId,
      jobId: response.data.jobId,
      resumeCommand,
      statusUrl: response.data.statusUrl,
      type: "job-accepted",
    },
    `Job ${response.data.jobId} queued. Waiting for completion; resume with ${resumeCommand}.\n`,
  );
};

const resumeEnvelope = (
  response: SuccessEnvelope<{
    readonly organizationId: string;
    readonly jobId: string;
    readonly statusUrl: string;
  }>,
) => ({
  correlationId: response.correlationId,
  data: {
    organizationId: response.data.organizationId,
    jobId: response.data.jobId,
    resumeCommand: `densio --org ${response.data.organizationId} jobs wait ${response.data.jobId}`,
    statusUrl: response.data.statusUrl,
  },
  ok: true as const,
  schemaVersion: 1 as const,
});
