import { requiredCommandFlag } from "./command-options.ts";
import { organizationResponses } from "./organization-responses.ts";
import {
  OrganizationInvitationAcceptResponseSchema,
  OrganizationInvitationCreateRequestSchema,
  OrganizationInvitationListQuerySchema,
  ReceivedInvitationsResponseSchema,
} from "@densio/shared";
import { CliUsageError } from "./cli-errors.ts";
import { parseCatalogCommand } from "./command-catalog.ts";
import { decodeCliOptions, requireSinglePositional } from "./command-options.ts";
import { directoryQuery } from "./organization-command-options.ts";
import {
  emitOrganizationRequest,
  emitAuthenticatedRequest,
} from "./organization-command-request.ts";
import { organizationPath, selectOrganization } from "./organization-context.ts";
import type { CliRuntime } from "./runtime.ts";

export const runInvitationsCommand = async (argv: ReadonlyArray<string>, runtime: CliRuntime) => {
  const [command, ...rest] = argv;
  if (command !== "list" && command !== "accept")
    throw new CliUsageError("invitations requires list or accept.");
  const parsed = parseCatalogCommand(`invitations ${command}`, rest);
  if (command === "list")
    return emitAuthenticatedRequest(
      runtime,
      `/v1/organization-invitations${directoryQuery(parsed, OrganizationInvitationListQuerySchema, "invitations list")}`,
      ReceivedInvitationsResponseSchema,
    );
  const invitationId = requireSinglePositional(
    parsed,
    "invitations accept requires one invitation ID.",
  );
  return emitAuthenticatedRequest(
    runtime,
    `/v1/organization-invitations/${encodeURIComponent(invitationId)}/accept`,
    OrganizationInvitationAcceptResponseSchema,
    "POST",
  );
};

export const runOrganizationInvitations = async (
  argv: ReadonlyArray<string>,
  runtime: CliRuntime,
) => {
  const [command, ...rest] = argv;
  if (command !== "list" && command !== "create" && command !== "revoke")
    throw new CliUsageError("orgs invitations requires list, create, or revoke.");
  const parsed = parseCatalogCommand(`orgs invitations ${command}`, rest);
  if (command === "list") {
    const query = directoryQuery(
      parsed,
      OrganizationInvitationListQuerySchema,
      "orgs invitations list",
    );
    const selected = await selectOrganization(runtime);
    return emitOrganizationRequest(
      selected,
      organizationPath(selected, `/invitations${query}`),
      organizationResponses.OrganizationInvitationsResponse,
    );
  }
  const value = requireSinglePositional(
    parsed,
    `orgs invitations ${command} requires one ${command === "create" ? "email address" : "invitation ID"}.`,
  );
  const body =
    command === "create"
      ? decodeCliOptions(
          OrganizationInvitationCreateRequestSchema,
          { email: value, role: requiredCommandFlag(parsed, "--role") },
          "orgs invitations create",
        )
      : undefined;
  const selected = await selectOrganization(runtime);
  return command === "create"
    ? emitOrganizationRequest(
        selected,
        organizationPath(selected, "/invitations"),
        organizationResponses.OrganizationInvitation,
        "POST",
        body,
      )
    : emitOrganizationRequest(
        selected,
        organizationPath(selected, `/invitations/${encodeURIComponent(value)}`),
        organizationResponses.OrganizationInvitation,
        "DELETE",
      );
};
