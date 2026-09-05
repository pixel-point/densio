import { runJobCreate } from "./job-create-command.ts";
import { parseUntil } from "./storage-options.ts";
import { organizationResponses } from "./organization-responses.ts";

import { materializeJobArtifacts } from "./artifact-materializer.ts";
import { numberFlag, singleFlag } from "./command-options.ts";
import { CliUsageError } from "./cli-errors.ts";
import { runJobEvents, runJobList, runJobLookup, runJobWatch } from "./job-recovery-commands.ts";
import { parseCatalogCommand } from "./command-catalog.ts";
import { selectJobOrganization, waitForJob } from "./job-waiter.ts";
import { emitSuccess, formatJobStatus } from "./render.ts";
import type { CliRuntime } from "./runtime.ts";
import { organizationPath, selectOrganization } from "./organization-context.ts";
import type { OrganizationRuntime } from "./organization-context.ts";

const decodeJobStatus = organizationResponses.JobStatus;

export const runJobsCommand = async (argv: ReadonlyArray<string>, unscopedRuntime: CliRuntime) => {
  const [recoveryCommand, ...recoveryArguments] = argv;
  if (recoveryCommand === "create") return runJobCreate(recoveryArguments, unscopedRuntime);
  if (recoveryCommand === "list") return runJobList(recoveryArguments, unscopedRuntime);
  if (recoveryCommand === "lookup") return runJobLookup(recoveryArguments, unscopedRuntime);
  if (recoveryCommand === "events") return runJobEvents(recoveryArguments, unscopedRuntime);
  if (recoveryCommand === "watch") {
    return runJobWatch(recoveryArguments, unscopedRuntime);
  }
  const command = recoveryCommand;
  if (command !== "get" && command !== "wait" && command !== "cancel") {
    throw new CliUsageError(
      "jobs requires create, list, lookup, events, watch, get, wait, or cancel.",
    );
  }
  const parsed = parseCatalogCommand(`jobs ${command}`, recoveryArguments);
  const [jobId, ...extra] = parsed.positionals;
  if (jobId === undefined || extra.length > 0)
    throw new CliUsageError(`jobs ${command} requires one job ID.`);
  const outputDirectory = singleFlag(parsed, "--output-dir");
  const force = parsed.switches.has("--force");
  if (command === "wait") requireOutputDirectoryForForce(outputDirectory, force);
  const timeoutSeconds = numberFlag(parsed, "--timeout");
  if (timeoutSeconds !== undefined && timeoutSeconds <= 0)
    throw new CliUsageError("--timeout must be positive.");
  const runtime =
    command === "wait"
      ? await selectJobOrganization(unscopedRuntime, jobId, "wait")
      : await selectOrganization(unscopedRuntime);
  const path = `${organizationPath(runtime)}/jobs/${encodeURIComponent(jobId)}${command === "cancel" ? "/cancel" : ""}`;
  if (command === "wait") {
    const response = await waitForJob(
      runtime,
      jobId,
      path,
      timeoutSeconds,
      "wait",
      parseUntil(parsed),
    );
    await emitJobCompletion(runtime, jobId, response, outputDirectory, force);
    return;
  }
  const response = await runtime.organizationClient.request(
    path,
    { method: command === "cancel" ? "POST" : "GET" },
    decodeJobStatus,
  );
  emitSuccess(runtime, response, formatJobStatus(response.data));
};

const requireOutputDirectoryForForce = (outputDirectory: string | undefined, force: boolean) => {
  if (force && outputDirectory === undefined) {
    throw new CliUsageError("--force requires --output-dir.");
  }
};

const emitJobCompletion = async (
  runtime: OrganizationRuntime,
  jobId: string,
  response: Awaited<ReturnType<typeof waitForJob>>,
  outputDirectory: string | undefined,
  force: boolean,
) => {
  if (outputDirectory === undefined || response.data.state !== "succeeded") {
    emitSuccess(runtime, response, formatJobStatus(response.data));
    return;
  }
  const materialized = await materializeJobArtifacts(runtime, jobId, outputDirectory, force);
  emitSuccess(
    runtime,
    materialized,
    `Materialized ${materialized.data.files.length} artifacts in ${materialized.data.outputDirectory}.\n`,
  );
};
