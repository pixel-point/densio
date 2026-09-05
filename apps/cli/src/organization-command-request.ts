import { successEnvelope } from "@densio/shared";
import { Schema } from "effect";
import { createAuthenticatedClient } from "./authenticated-client.ts";
import { jsonRequest } from "./http-client.ts";
import type { OrganizationRuntime } from "./organization-context.ts";
import type { OrganizationResponse } from "./organization-client.ts";
import { emitSuccess } from "./render.ts";
import type { CliRuntime } from "./runtime.ts";

export const emitAuthenticatedRequest = async (
  runtime: CliRuntime,
  path: string,
  schema: Schema.Codec<unknown, unknown>,
  method = "GET",
  body?: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
) => {
  const client = await createAuthenticatedClient(runtime);
  const response = await client.request(
    path,
    jsonRequest(method, body, {
      ...extraHeaders,
    }),
    Schema.decodeUnknownEffect(successEnvelope(schema)),
  );
  emitSuccess(runtime, response, `${JSON.stringify(response.data, null, 2)}\n`);
};

export const emitOrganizationRequest = async <Value>(
  runtime: OrganizationRuntime,
  path: string,
  response: OrganizationResponse<Value>,
  method = "GET",
  body?: unknown,
) => {
  const result = await runtime.organizationClient.request(
    path,
    jsonRequest(method, body),
    response,
  );
  emitSuccess(runtime, result, `${JSON.stringify(result.data, null, 2)}\n`);
};
