import { isJobDeliveryComplete } from "./storage-wait.ts";
import { organizationResponses } from "./organization-responses.ts";
import type { OrganizationRuntime } from "./organization-context.ts";
import { type JobEvent, type JobStatus } from "@densio/shared";

import { CliProblemError, invalidResponseError } from "./cli-errors.ts";
import { CLI_EXIT_CODES } from "./output.ts";
import { pollUntilComplete } from "./polling.ts";
import type { CliRuntime } from "./runtime.ts";
import { organizationPath, selectOrganization } from "./organization-context.ts";

const decodeEvents = organizationResponses.JobEventPage;
const decodeStatus = organizationResponses.JobStatus;

export const selectJobOrganization = async (
  runtime: CliRuntime,
  jobId: string,
  command: "wait" | "watch",
) => {
  const interrupted = () =>
    waitError(
      runtime.explicitOrganizationId ?? runtime.environmentOrganizationId ?? "ORG_ID",
      jobId,
      command,
      "CLI_INTERRUPTED",
    );
  if (runtime.signal?.aborted === true) throw interrupted();
  return selectOrganization(runtime).catch((cause: unknown) => {
    if (runtime.signal?.aborted === true) throw interrupted();
    throw cause;
  });
};

export const waitForJob = async (
  runtime: OrganizationRuntime,
  jobId: string,
  statusUrl: string,
  timeoutSeconds?: number,
  command: "wait" | "watch" = "wait",
  until?: "compressed" | "stored",
) => {
  let cursor = 0;
  return pollUntilComplete({
    runtime,
    initialDelayMilliseconds: 0,
    ...(timeoutSeconds === undefined ? {} : { deadlineAt: runtime.now() + timeoutSeconds * 1_000 }),
    interruptedError: () =>
      waitError(runtime.organization?.organizationId ?? "", jobId, command, "CLI_INTERRUPTED"),
    timeoutError: () =>
      waitError(runtime.organization?.organizationId ?? "", jobId, command, "CLI_WAIT_TIMEOUT"),
    isRetryableFailure: (cause) =>
      cause instanceof CliProblemError &&
      (cause.exitCode === CLI_EXIT_CODES.network || cause.problem.retryable),
    poll: async (signal) => {
      const page = await readJobEvents(runtime, jobId, cursor, signal);
      cursor = page.cursor;
      const status = await runtime.organizationClient.request(
        statusUrl,
        { method: "GET", signal },
        decodeStatus,
      );
      if (status.data.id !== jobId) throw invalidResponseError();
      if (!page.full && ["succeeded", "failed", "canceled"].includes(status.data.state)) {
        // Completion may have been committed after the first event read.
        const tail = await readJobEvents(runtime, jobId, cursor, signal);
        cursor = tail.cursor;
        return { status, drainBacklog: tail.full };
      }
      return { status, drainBacklog: page.full };
    },
    decide: ({ status, drainBacklog }) => {
      if (drainBacklog) return { kind: "pending", delayMilliseconds: 0 };
      throwTerminalFailure(status.data);
      return isJobDeliveryComplete(status.data, until)
        ? { kind: "complete", value: status }
        : { kind: "pending", delayMilliseconds: 2_000 };
    },
  });
};

const readJobEvents = async (
  runtime: OrganizationRuntime,
  jobId: string,
  cursor: number,
  signal: AbortSignal,
) => {
  const events = await runtime.organizationClient.request(
    `${organizationPath(runtime)}/jobs/${encodeURIComponent(jobId)}/events?after=${cursor}&limit=100`,
    { method: "GET", signal },
    decodeEvents,
  );
  if (events.data.events.some((event) => event.jobId !== jobId)) throw invalidResponseError();
  const fresh = uniqueEventsAfter(events.data.events, cursor);
  const next = Math.max(cursor, events.data.nextCursor, ...fresh.map(({ sequence }) => sequence));
  const full = events.data.events.length >= 100;
  if (full && next <= cursor) throw invalidResponseError();
  fresh.forEach((event) =>
    runtime.writeStderr(
      runtime.json
        ? `${JSON.stringify({ ...event, type: "job-event" })}\n`
        : `${event.sequence} ${event.kind} ${event.state}\n`,
    ),
  );
  return { cursor: next, full };
};

const uniqueEventsAfter = (events: ReadonlyArray<JobEvent>, cursor: number) => {
  const sequences = new Set<number>();
  return events
    .filter(({ sequence }) => {
      if (sequence <= cursor || sequences.has(sequence)) return false;
      sequences.add(sequence);
      return true;
    })
    .toSorted((left, right) => left.sequence - right.sequence);
};

const throwTerminalFailure = (status: JobStatus) => {
  if (status.state === "failed") throw new CliProblemError(status.problem);
  if (status.state !== "canceled") return;
  throw new CliProblemError(
    status.problem ?? {
      code: "JOB_CANCELED",
      correlationId: "local",
      detail: `Job ${status.id} is canceled.`,
      jobId: status.id,
      retryable: false,
      schemaVersion: 1,
      status: 409,
      suggestedAction: "Execute a new plan if another result is required.",
      title: "Job canceled",
      type: "about:blank",
    },
  );
};

const waitError = (
  organizationId: string,
  jobId: string,
  command: "wait" | "watch",
  code: "CLI_INTERRUPTED" | "CLI_WAIT_TIMEOUT",
) =>
  new CliProblemError(
    {
      code,
      correlationId: "local",
      jobId,
      schemaVersion: 1,
      detail:
        code === "CLI_INTERRUPTED"
          ? `Stopped waiting for job ${jobId}; the server job is still running.`
          : `Timed out waiting for job ${jobId}.`,
      retryable: code === "CLI_WAIT_TIMEOUT",
      status: code === "CLI_INTERRUPTED" ? 499 : 504,
      suggestedAction: `Resume with densio --org ${organizationId} jobs ${command} ${jobId}.`,
      title: code === "CLI_INTERRUPTED" ? "Wait interrupted" : "Wait timed out",
      type: "about:blank",
    },
    code === "CLI_INTERRUPTED" ? CLI_EXIT_CODES.interrupted : CLI_EXIT_CODES.network,
  );
