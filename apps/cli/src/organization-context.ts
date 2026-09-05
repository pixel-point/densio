import { OrganizationMembershipSchema, successEnvelope } from "@densio/shared";
import { Schema } from "effect";
import { CliUsageError, invalidResponseError } from "./cli-errors.ts";
import { createAuthenticatedClient, type AuthenticatedClient } from "./authenticated-client.ts";
import {
  createOrganizationClient,
  type OrganizationClient,
  type OrganizationResponse,
} from "./organization-client.ts";
import { readOrganizationContext } from "./organization-context-store.ts";
import { emitStatusEvent } from "./render.ts";
import type { CliRuntime } from "./runtime.ts";

const decodeMembership = Schema.decodeUnknownEffect(successEnvelope(OrganizationMembershipSchema));

export interface OrganizationRuntime extends CliRuntime {
  readonly organization: { readonly organizationId: string; readonly name: string };
  readonly authenticatedClient: AuthenticatedClient;
  readonly organizationClient: OrganizationClient;
}

export const selectOrganization = async (
  runtime: CliRuntime,
  positionalId?: string,
  options: { allowClosed?: boolean } = {},
) => {
  if (
    positionalId !== undefined &&
    runtime.explicitOrganizationId !== undefined &&
    positionalId !== runtime.explicitOrganizationId
  ) {
    throw new CliUsageError("The positional organization ID conflicts with --org.");
  }
  const authenticatedClient = await createAuthenticatedClient(runtime);
  const userId = authenticatedClient.userId;
  const organizationId =
    positionalId ??
    runtime.explicitOrganizationId ??
    runtime.environmentOrganizationId ??
    (await readOrganizationContext(runtime.credentialsPath, runtime.apiUrl, userId)) ??
    authenticatedClient.defaultOrganizationId;
  if (organizationId.trim().length === 0)
    throw new CliUsageError("Organization ID must not be empty.");
  const response = await authenticatedClient.request(
    `/v1/organizations/${encodeURIComponent(organizationId)}`,
    {},
    decodeMembership,
  );
  if (
    response.data.organization.organizationId !== organizationId ||
    response.data.membership.organizationId !== organizationId ||
    response.data.membership.userId !== userId
  ) {
    throw invalidResponseError();
  }
  if (response.data.organization.state !== "active" && options.allowClosed !== true)
    throw new CliUsageError(
      "This organization is closing or deleted. Select an active organization; use orgs get to check closure.",
    );
  const organization = { organizationId, name: response.data.organization.name };
  emitStatusEvent(
    runtime,
    { type: "organization-selected", ...organization },
    `Organization ${organization.name} (${organizationId}).\n`,
  );
  return {
    ...runtime,
    authenticatedClient,
    organizationClient: createOrganizationClient(runtime, authenticatedClient, organizationId),
    organization,
  } satisfies OrganizationRuntime;
};

export const organizationPath = (runtime: OrganizationRuntime, suffix = "") => {
  return `/v1/organizations/${encodeURIComponent(runtime.organization.organizationId)}${suffix}`;
};

// Capture validated request data before authentication and organization selection.
export const prepareOrganizationRequest =
  <Value>(suffix: string, init: RequestInit, response: OrganizationResponse<Value>) =>
  (runtime: OrganizationRuntime) =>
    runtime.organizationClient.request(organizationPath(runtime, suffix), init, response);
