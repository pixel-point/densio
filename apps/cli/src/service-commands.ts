import {
  BillingSessionResponseSchema,
  CapabilitiesSchema,
  successEnvelope,
} from "@ffmpeg-api/shared";
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
  const [command, ...extra] = argumentsInput;
  if ((command !== "subscribe" && command !== "portal") || extra.length > 0) {
    throw new CliUsageError("billing requires subscribe or portal.");
  }
  const headers = await authorizationHeaders(runtime);
  const path = command === "subscribe" ? "/v1/billing/checkout" : "/v1/billing/portal";
  const response = await requestJson(
    runtime,
    path,
    jsonRequest("POST", undefined, headers),
    decodeBillingSession,
  );
  emitSuccess(runtime, response, `${response.data.url}\n`);
};
