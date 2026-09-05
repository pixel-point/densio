import { JobCreateRequestSchema } from "@densio/shared";
import { parsePlanCreate } from "./plan-options.ts";
import { decodeCliOptions, singleFlag } from "./command-options.ts";
import { CliUsageError } from "./cli-errors.ts";
import { organizationResponses } from "./organization-responses.ts";
import { organizationPath, selectOrganization } from "./organization-context.ts";
import { jsonRequest } from "./http-client.ts";
import { finishSubmission, parseSubmissionControls } from "./submission-support.ts";
import type { CliRuntime } from "./runtime.ts";

export const runJobCreate = async (argv: ReadonlyArray<string>, unscopedRuntime: CliRuntime) => {
  const parsed = parsePlanCreate(argv, "jobs create");
  if (parsed.idempotencyKey === undefined)
    throw new CliUsageError("jobs create requires --idempotency-key.");
  const controls = parseSubmissionControls(parsed.parsed);
  const clientReference = singleFlag(parsed.parsed, "--client-reference");
  const request = decodeCliOptions(
    JobCreateRequestSchema,
    { ...parsed.request, ...(clientReference === undefined ? {} : { clientReference }) },
    "jobs create",
  );
  if (
    controls.until === "stored" &&
    request.workflow !== "compress" &&
    request.workflow !== "trim" &&
    request.workflow !== "hls"
  )
    throw new CliUsageError(
      "--until stored requires compression, trimming, or HLS with durable storage.",
    );
  if (
    controls.until === "stored" &&
    "storage" in request &&
    request.storage?.destination?.kind === "temporary"
  )
    throw new CliUsageError("--until stored requires a durable destination.");
  const runtime = await selectOrganization(unscopedRuntime);
  const response = await runtime.organizationClient.request(
    organizationPath(runtime, "/jobs"),
    jsonRequest("POST", request, { "idempotency-key": parsed.idempotencyKey }),
    organizationResponses.ExecutionPlanExecuteResponse,
  );
  await finishSubmission(runtime, response, controls);
};
