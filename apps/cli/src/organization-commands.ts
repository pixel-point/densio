import { requiredCommandFlag } from "./command-options.ts";
import { organizationResponses } from "./organization-responses.ts";
import { Schema } from "effect";
import { successEnvelope } from "@densio/shared";
import { jsonRequest } from "./http-client.ts";
import { invalidResponseError } from "./cli-errors.ts";
import type { OrganizationRuntime } from "./organization-context.ts";
import {
  DefaultOrganizationRequestSchema,
  OrganizationAuditQuerySchema,
  OrganizationCreateRequestSchema,
  OrganizationCreateResponseSchema,
  OrganizationListQuerySchema,
  OrganizationListResponseSchema,
  OrganizationRenameRequestSchema,
  OrganizationTransferRequestSchema,
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
import { writeOrganizationContext } from "./organization-context-store.ts";
import { runOrganizationMembers } from "./organization-member-commands.ts";
import { runOrganizationInvitations } from "./organization-invitation-commands.ts";
import { emitSuccess } from "./render.ts";
import type { CliRuntime } from "./runtime.ts";

export const runOrganizationsCommand = async (argv: ReadonlyArray<string>, runtime: CliRuntime) => {
  const [command, ...rest] = argv;
  if (command === "members") return runOrganizationMembers(rest, runtime);
  if (command === "invitations") return runOrganizationInvitations(rest, runtime);
  if (command === "list" || command === "create") return runDirectory(command, rest, runtime);
  if (
    command === "get" ||
    command === "rename" ||
    command === "use" ||
    command === "default" ||
    command === "delete"
  )
    return runPositional(command, rest, runtime);
  if (command === "leave" || command === "transfer-ownership" || command === "audit-events")
    return runSelected(command, rest, runtime);
  throw new CliUsageError(
    "orgs requires list, create, get, rename, use, default, members, invitations, leave, transfer-ownership, audit-events, or delete.",
  );
};

const runDirectory = async (
  command: "list" | "create",
  argv: ReadonlyArray<string>,
  runtime: CliRuntime,
) => {
  const parsed = parseCatalogCommand(`orgs ${command}`, argv);
  if (command === "list")
    return emitAuthenticatedRequest(
      runtime,
      `/v1/organizations${directoryQuery(parsed, OrganizationListQuerySchema, "orgs list")}`,
      OrganizationListResponseSchema,
    );
  const name = requireSinglePositional(parsed, "orgs create requires one organization name.");
  const body = decodeCliOptions(OrganizationCreateRequestSchema, { name }, "orgs create");
  const key = requiredCommandFlag(parsed, "--idempotency-key");
  return emitAuthenticatedRequest(
    runtime,
    "/v1/organizations",
    OrganizationCreateResponseSchema,
    "POST",
    body,
    { "idempotency-key": key },
  );
};

const runPositional = async (
  command: "get" | "rename" | "use" | "default" | "delete",
  argv: ReadonlyArray<string>,
  runtime: CliRuntime,
) => {
  const parsed = parseCatalogCommand(`orgs ${command}`, argv);
  const [organizationId, name] = parsed.positionals;
  if (organizationId === undefined || parsed.positionals.length !== (command === "rename" ? 2 : 1))
    throw new CliUsageError(
      `orgs ${command} requires an organization ID${command === "rename" ? " and name" : ""}.`,
    );
  if (command === "delete" && requiredCommandFlag(parsed, "--confirm") !== organizationId)
    throw new CliUsageError("--confirm must exactly match the organization ID being deleted.");
  const rename =
    command === "rename"
      ? decodeCliOptions(OrganizationRenameRequestSchema, { name }, "orgs rename")
      : undefined;
  const selected = await selectOrganization(runtime, organizationId, {
    allowClosed: command === "get" || command === "delete",
  });
  if (command === "use") {
    await writeOrganizationContext(selected.credentialsPath, {
      apiOrigin: selected.apiUrl,
      userId: selected.authenticatedClient.userId,
      organizationId,
    });
    emitSuccess(
      selected,
      {
        ok: true,
        schemaVersion: 1,
        correlationId: "local",
        data: { organizationId, scope: "local" },
      },
      `Selected ${organizationId} locally. Server default unchanged.\n`,
    );
    return;
  }
  if (command === "default") return emitDefaultOrganization(selected, organizationId);
  if (command === "rename")
    return emitOrganizationRequest(
      selected,
      organizationPath(selected),
      organizationResponses.Organization,
      "PATCH",
      rename,
    );
  if (command === "delete")
    return emitOrganizationRequest(
      selected,
      organizationPath(selected),
      organizationResponses.OrganizationDeletionReceipt,
      "DELETE",
    );
  return emitOrganizationRequest(
    selected,
    organizationPath(selected),
    organizationResponses.OrganizationMembership,
  );
};

const runSelected = async (
  command: "leave" | "transfer-ownership" | "audit-events",
  argv: ReadonlyArray<string>,
  runtime: CliRuntime,
) => {
  const parsed = parseCatalogCommand(`orgs ${command}`, argv);
  const query =
    command === "audit-events"
      ? directoryQuery(parsed, OrganizationAuditQuerySchema, "orgs audit-events")
      : "";
  const transfer =
    command === "transfer-ownership"
      ? decodeCliOptions(
          OrganizationTransferRequestSchema,
          { userId: requireSinglePositional(parsed, "transfer-ownership requires a user ID.") },
          "orgs transfer-ownership",
        )
      : undefined;
  if (command === "leave" && parsed.positionals.length > 0)
    throw new CliUsageError("orgs leave accepts no arguments.");
  const selected = await selectOrganization(runtime);
  if (command === "audit-events")
    return emitOrganizationRequest(
      selected,
      organizationPath(selected, `/audit-events${query}`),
      organizationResponses.OrganizationAuditPage,
    );
  if (command === "leave")
    return emitOrganizationRequest(
      selected,
      organizationPath(selected, "/leave"),
      organizationResponses.OrganizationMemberRemoval,
      "POST",
    );
  return emitOrganizationRequest(
    selected,
    organizationPath(selected, "/transfer-ownership"),
    organizationResponses.OrganizationMember,
    "POST",
    transfer,
  );
};

const emitDefaultOrganization = async (runtime: OrganizationRuntime, organizationId: string) => {
  const response = await runtime.authenticatedClient.request(
    "/v1/auth/default-organization",
    jsonRequest("PUT", { organizationId }),
    Schema.decodeUnknownEffect(successEnvelope(DefaultOrganizationRequestSchema)),
  );
  if (response.data.organizationId !== organizationId) throw invalidResponseError();
  emitSuccess(runtime, response, `Default organization set to ${organizationId}.\n`);
};
