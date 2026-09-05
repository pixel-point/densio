import { successEnvelope, type SuccessEnvelope } from "@densio/shared";
import { Schema } from "effect";
import type { AuthenticatedClient } from "./authenticated-client.ts";
import { invalidResponseError } from "./cli-errors.ts";
import { controlRequestUrl } from "./control-request-policy.ts";
import type { ResponseDecoder } from "./http-client.ts";
import type { CliRuntime } from "./runtime.ts";

type OwnedResource = { readonly organizationId: string };
export interface OrganizationResponse<Value> {
  readonly decode: ResponseDecoder<SuccessEnvelope<Value>>;
  readonly owners: (value: Value) => readonly OwnedResource[];
}

// Ownership comes from the decoded contract, not arbitrary JSON property names.
export const organizationResponse = <Value, Encoded>(
  schema: Schema.Codec<Value, Encoded>,
  owners: (value: Value) => readonly OwnedResource[],
): OrganizationResponse<Value> => ({
  decode: Schema.decodeUnknownEffect(successEnvelope(schema)),
  owners,
});

export const createOrganizationClient = (
  runtime: CliRuntime,
  authenticated: AuthenticatedClient,
  organizationId: string,
) => {
  const basePath = `/v1/organizations/${encodeURIComponent(organizationId)}`;
  return {
    request: async <Value>(
      path: string,
      init: RequestInit,
      response: OrganizationResponse<Value>,
    ) => {
      const url = controlRequestUrl(runtime, path);
      if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`))
        throw invalidResponseError();
      const result = await authenticated.request(url.toString(), init, response.decode);
      if (
        response.owners(result.data).some((resource) => resource.organizationId !== organizationId)
      )
        throw invalidResponseError();
      return result;
    },
  };
};
export type OrganizationClient = ReturnType<typeof createOrganizationClient>;
