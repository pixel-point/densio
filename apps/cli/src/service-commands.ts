import {
  BillingSessionResponseSchema,
  CapabilitiesSchema,
  PAID_PLANS,
  successEnvelope,
} from "@densio/shared";
import { Schema } from "effect";

import { authorizationHeaders } from "./authentication.ts";
import { CliUsageError } from "./cli-errors.ts";
import { jsonRequest, requestJson } from "./http-client.ts";
import { emitSuccess } from "./render.ts";
import type { CliRuntime } from "./runtime.ts";

const decodeCapabilities = Schema.decodeUnknownEffect(successEnvelope(CapabilitiesSchema));
const decodeBillingSession = Schema.decodeUnknownEffect(
  successEnvelope(BillingSessionResponseSchema),
);

export const runCapabilitiesCommand = async (
  argumentsInput: ReadonlyArray<string>,
  runtime: CliRuntime,
) => {
  if (argumentsInput.length > 0) throw new CliUsageError("capabilities accepts no arguments.");
  const headers = await authorizationHeaders(runtime, false);
  const response = await requestJson(
    runtime,
    "/v1/capabilities",
    { headers, method: "GET" },
    decodeCapabilities,
  );
  emitSuccess(
    runtime,
    response,
    `Plan ${response.data.plan}; codecs ${response.data.codecs.map(({ codec }) => codec).join(", ")}.\n`,
  );
};

export const runBillingCommand = async (
  argumentsInput: ReadonlyArray<string>,
  runtime: CliRuntime,
) => {
  const [command, plan, ...extra] = argumentsInput;
  const paidPlan = PAID_PLANS.find((candidate) => candidate === plan);
  const validPortal = command === "portal" && plan === undefined;
  const validSubscription = command === "subscribe" && paidPlan !== undefined && extra.length === 0;
  if (!validPortal && !validSubscription) {
    throw new CliUsageError("billing requires subscribe basic|pro|scale or portal.");
  }
  const headers = await authorizationHeaders(runtime);
  const path = command === "subscribe" ? "/v1/billing/checkout" : "/v1/billing/portal";
  const response = await requestJson(
    runtime,
    path,
    jsonRequest("POST", command === "subscribe" ? { plan: paidPlan } : undefined, headers),
    decodeBillingSession,
  );
  emitSuccess(runtime, response, `${response.data.url}\n`);
};
