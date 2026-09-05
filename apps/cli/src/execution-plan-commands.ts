import { finishSubmission, parseSubmissionControls } from "./submission-support.ts";
import { organizationResponses } from "./organization-responses.ts";
import {
  ExecutionPlanExecuteRequestSchema,
  ExecutionPlanResolveRequestSchema,
  type ExecutionPlanStatus,
} from "@densio/shared";

import { decodeCliOptions, numberFlag, singleFlag } from "./command-options.ts";
import { CliUsageError } from "./cli-errors.ts";
import { jsonRequest } from "./http-client.ts";
import { parsePlanCreate } from "./plan-options.ts";
import { parseCatalogCommand } from "./command-catalog.ts";
import { emitSuccess } from "./render.ts";
import type { CliRuntime } from "./runtime.ts";
import { organizationPath, selectOrganization } from "./organization-context.ts";

const decodeCreated = organizationResponses.ExecutionPlanCreateResponse;
const decodeStatus = organizationResponses.ExecutionPlanStatus;
const decodeResolved = organizationResponses.ExecutionPlanResolveResponse;
const decodeExecuted = organizationResponses.ExecutionPlanExecuteResponse;

export const runExecutionPlansCommand = async (
  argv: ReadonlyArray<string>,
  runtime: CliRuntime,
) => {
  const [command, ...argumentsRemaining] = argv;
  if (command === "create") return runCreate(argumentsRemaining, runtime);
  if (command === "get") return runGet(argumentsRemaining, runtime);
  if (command === "resolve") return runResolve(argumentsRemaining, runtime);
  if (command === "execute") return runExecute(argumentsRemaining, runtime);
  throw new CliUsageError("plans requires create, get, resolve, or execute.");
};

const runCreate = async (argv: ReadonlyArray<string>, unscopedRuntime: CliRuntime) => {
  const parsed = parsePlanCreate(argv);
  const runtime = await selectOrganization(unscopedRuntime);
  const response = await runtime.organizationClient.request(
    organizationPath(runtime, "/execution-plans"),
    jsonRequest(
      "POST",
      parsed.request,
      parsed.idempotencyKey === undefined ? {} : { "idempotency-key": parsed.idempotencyKey },
    ),
    decodeCreated,
  );
  emitSuccess(runtime, response, formatPlan(response.data.plan));
};

const runGet = async (argv: ReadonlyArray<string>, unscopedRuntime: CliRuntime) => {
  const parsed = parseCatalogCommand("plans get", argv);
  const [planId, ...extra] = parsed.positionals;
  if (planId === undefined || extra.length > 0) {
    throw new CliUsageError("plans get requires exactly one plan ID.");
  }
  const runtime = await selectOrganization(unscopedRuntime);
  const response = await runtime.organizationClient.request(
    `${organizationPath(runtime)}/execution-plans/${encodeURIComponent(planId)}`,
    { method: "GET" },
    decodeStatus,
  );
  emitSuccess(runtime, response, formatPlan(response.data));
};

const runResolve = async (argv: ReadonlyArray<string>, unscopedRuntime: CliRuntime) => {
  const parsed = parseCatalogCommand("plans resolve", argv);
  const [planId, decision, ...extra] = parsed.positionals;
  if (planId === undefined || decision === undefined || extra.length > 0) {
    throw new CliUsageError("plans resolve requires a plan ID and preserve or cap-30.");
  }
  const request = decodeCliOptions(
    ExecutionPlanResolveRequestSchema,
    { frameRate: parseFrameRate(decision) },
    "plans resolve",
  );
  const idempotencyKey = singleFlag(parsed, "--idempotency-key");
  const runtime = await selectOrganization(unscopedRuntime);
  const response = await runtime.organizationClient.request(
    `${organizationPath(runtime)}/execution-plans/${encodeURIComponent(planId)}/resolve`,
    jsonRequest(
      "POST",
      request,
      idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey },
    ),
    decodeResolved,
  );
  emitSuccess(runtime, response, formatPlan(response.data.plan));
};

const runExecute = async (argv: ReadonlyArray<string>, unscopedRuntime: CliRuntime) => {
  const parsed = parseExecute(argv);
  const runtime = await selectOrganization(unscopedRuntime);
  const response = await runtime.organizationClient.request(
    `${organizationPath(runtime)}/execution-plans/${encodeURIComponent(parsed.planId)}/execute`,
    jsonRequest("POST", parsed.request, {
      "idempotency-key": parsed.idempotencyKey,
    }),
    decodeExecuted,
  );
  await finishSubmission(runtime, response, parsed);
};

const parseExecute = (argv: ReadonlyArray<string>) => {
  const parsed = parseCatalogCommand("plans execute", argv);
  const [planId, ...extra] = parsed.positionals;
  if (planId === undefined || extra.length > 0) {
    throw new CliUsageError("plans execute requires exactly one plan ID.");
  }
  const idempotencyKey = singleFlag(parsed, "--idempotency-key");
  if (idempotencyKey === undefined) {
    throw new CliUsageError("plans execute requires --idempotency-key.");
  }
  const clientReference = singleFlag(parsed, "--client-reference");
  const maxCredits = numberFlag(parsed, "--max-credits");
  const maxOutputBytes = numberFlag(parsed, "--max-output-bytes");
  const request = decodeCliOptions(
    ExecutionPlanExecuteRequestSchema,
    {
      ...(clientReference === undefined ? {} : { clientReference }),
      ...(maxCredits === undefined ? {} : { maxCredits }),
      ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
    },
    "plans execute",
  );
  return { idempotencyKey, planId, request, ...parseSubmissionControls(parsed) };
};

const parseFrameRate = (value: string) => {
  if (value === "preserve") return { mode: "preserve" as const };
  if (value === "cap-30") return { maximum: 30 as const, mode: "cap" as const };
  throw new CliUsageError("Frame-rate decision must be preserve or cap-30.");
};

const formatPlan = (plan: ExecutionPlanStatus) => {
  if (plan.availability !== "available") return `${plan.planId} ${plan.availability}.\n`;
  if (plan.state === "decision-required") {
    return [
      `${plan.planId} requires a frame-rate decision.`,
      `densio --org ${plan.organizationId} plans resolve ${plan.planId} cap-30`,
      `densio --org ${plan.organizationId} plans resolve ${plan.planId} preserve`,
      "",
    ].join("\n");
  }
  return `${plan.planId} ready: ${plan.quote.credits.toFixed(2)} credits, ${plan.expectedArtifacts.length} expected artifacts.\n`;
};
