import { organizationResponses } from "./organization-responses.ts";
import { JobListQuerySchema, JobLookupQuerySchema, type JobEvent } from "@densio/shared";

import {
  decodeCliOptions,
  numberFlag,
  requireSinglePositional,
  singleFlag,
} from "./command-options.ts";
import { CliUsageError } from "./cli-errors.ts";
import { parseCatalogCommand } from "./command-catalog.ts";
import { selectJobOrganization, waitForJob } from "./job-waiter.ts";
import { emitSuccess, formatJobStatus } from "./render.ts";
import type { CliRuntime } from "./runtime.ts";
import { organizationPath, selectOrganization } from "./organization-context.ts";

const decodeJobList = organizationResponses.JobListResponse;
const decodeJobLookup = organizationResponses.JobLookupResponse;
const decodeJobEvents = organizationResponses.JobEventPage;

export const runJobList = async (argv: ReadonlyArray<string>, unscopedRuntime: CliRuntime) => {
  const parsed = parseCatalogCommand("jobs list", argv);
  if (parsed.positionals.length > 0) throw new CliUsageError("jobs list accepts only filters.");
  const query = decodeCliOptions(
    JobListQuerySchema,
    compactRecord({
      clientReference: singleFlag(parsed, "--client-reference"),
      cursor: singleFlag(parsed, "--cursor"),
      idempotencyKey: singleFlag(parsed, "--idempotency-key"),
      limit: numberFlag(parsed, "--limit"),
      since: singleFlag(parsed, "--since"),
      state: singleFlag(parsed, "--state"),
      workflow: singleFlag(parsed, "--workflow"),
    }),
    "jobs list",
  );
  const runtime = await selectOrganization(unscopedRuntime);
  const response = await runtime.organizationClient.request(
    `${organizationPath(runtime)}/jobs${queryString(query)}`,
    { method: "GET" },
    decodeJobList,
  );
  emitSuccess(
    runtime,
    response,
    response.data.jobs.length === 0
      ? "No jobs found.\n"
      : `${response.data.jobs.map(({ id, state, workflow }) => `${id} ${workflow} ${state}`).join("\n")}\n`,
  );
};

export const runJobLookup = async (argv: ReadonlyArray<string>, unscopedRuntime: CliRuntime) => {
  const parsed = parseCatalogCommand("jobs lookup", argv);
  if (parsed.positionals.length > 0)
    throw new CliUsageError("jobs lookup accepts only a selector.");
  const clientReference = singleFlag(parsed, "--client-reference");
  const idempotencyKey = singleFlag(parsed, "--idempotency-key");
  if ((clientReference === undefined) === (idempotencyKey === undefined)) {
    throw new CliUsageError(
      "jobs lookup requires exactly one of --client-reference or --idempotency-key.",
    );
  }
  const query = decodeCliOptions(
    JobLookupQuerySchema,
    compactRecord({ clientReference, idempotencyKey }),
    "jobs lookup",
  );
  const runtime = await selectOrganization(unscopedRuntime);
  const response = await runtime.organizationClient.request(
    `${organizationPath(runtime)}/jobs/lookup${queryString(query)}`,
    { method: "GET" },
    decodeJobLookup,
  );
  emitSuccess(runtime, response, formatJobStatus(response.data));
};

export const runJobEvents = async (argv: ReadonlyArray<string>, unscopedRuntime: CliRuntime) => {
  const { after, jobId, limit } = parseEventArguments(argv);
  const runtime = await selectOrganization(unscopedRuntime);
  const response = await runtime.organizationClient.request(
    `${organizationPath(runtime)}/jobs/${encodeURIComponent(jobId)}/events?after=${after}&limit=${limit}`,
    { method: "GET" },
    decodeJobEvents,
  );
  emitSuccess(
    runtime,
    response,
    response.data.events.length === 0
      ? `No events after sequence ${after}.\n`
      : `${response.data.events.map(formatHumanEvent).join("\n")}\n`,
  );
};

export const runJobWatch = async (argv: ReadonlyArray<string>, unscopedRuntime: CliRuntime) => {
  const parsed = parseCatalogCommand("jobs watch", argv);
  const jobId = requireSinglePositional(parsed, "jobs watch requires one job ID.");
  const timeoutSeconds = numberFlag(parsed, "--timeout");
  if (timeoutSeconds !== undefined && timeoutSeconds <= 0)
    throw new CliUsageError("--timeout must be positive.");
  const runtime = await selectJobOrganization(unscopedRuntime, jobId, "watch");
  const response = await waitForJob(
    runtime,
    jobId,
    `${organizationPath(runtime)}/jobs/${encodeURIComponent(jobId)}`,
    timeoutSeconds,
    "watch",
  );
  emitSuccess(runtime, response, formatJobStatus(response.data));
};

const parseEventArguments = (argv: ReadonlyArray<string>) => {
  const parsed = parseCatalogCommand("jobs events", argv);
  const jobId = requireSinglePositional(parsed, "jobs events requires one job ID.");
  const after = numberFlag(parsed, "--after") ?? 0;
  const limit = numberFlag(parsed, "--limit") ?? 100;
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new CliUsageError("--after must be a non-negative integer.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new CliUsageError("--limit must be an integer from 1 to 100.");
  }
  return { after, jobId, limit } as const;
};

const formatHumanEvent = ({ kind, sequence, state }: JobEvent) => `${sequence} ${kind} ${state}`;

const compactRecord = (record: Readonly<Record<string, string | number | undefined>>) =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));

const queryString = (query: Readonly<Record<string, unknown>>) => {
  const parameters = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => parameters.set(key, String(value)));
  const encoded = parameters.toString();
  return encoded.length === 0 ? "" : `?${encoded}`;
};
