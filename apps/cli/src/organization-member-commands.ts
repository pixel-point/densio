import { requiredCommandFlag } from "./command-options.ts";
import { organizationResponses } from "./organization-responses.ts";
import {
  OrganizationDirectoryQuerySchema,
  OrganizationMemberRoleRequestSchema,
} from "@densio/shared";
import { CliUsageError } from "./cli-errors.ts";
import { parseCatalogCommand } from "./command-catalog.ts";
import { decodeCliOptions, requireSinglePositional } from "./command-options.ts";
import { directoryQuery } from "./organization-command-options.ts";
import { emitOrganizationRequest } from "./organization-command-request.ts";
import { organizationPath, selectOrganization } from "./organization-context.ts";
import type { CliRuntime } from "./runtime.ts";

export const runOrganizationMembers = async (argv: ReadonlyArray<string>, runtime: CliRuntime) => {
  const [command, ...rest] = argv;
  if (command !== "list" && command !== "set-role" && command !== "remove")
    throw new CliUsageError("orgs members requires list, set-role, or remove.");
  const parsed = parseCatalogCommand(`orgs members ${command}`, rest);
  if (command === "list") {
    const query = directoryQuery(parsed, OrganizationDirectoryQuerySchema, "orgs members list");
    const selected = await selectOrganization(runtime);
    return emitOrganizationRequest(
      selected,
      organizationPath(selected, `/members${query}`),
      organizationResponses.OrganizationMembersResponse,
    );
  }
  const userId = requireSinglePositional(parsed, `orgs members ${command} requires one user ID.`);
  const body =
    command === "set-role"
      ? decodeCliOptions(
          OrganizationMemberRoleRequestSchema,
          { role: requiredCommandFlag(parsed, "--role") },
          "orgs members set-role",
        )
      : undefined;
  const selected = await selectOrganization(runtime);
  const path = organizationPath(selected, `/members/${encodeURIComponent(userId)}`);
  if (command === "remove")
    return emitOrganizationRequest(
      selected,
      path,
      organizationResponses.OrganizationMemberRemoval,
      "DELETE",
    );
  return emitOrganizationRequest(
    selected,
    path,
    organizationResponses.OrganizationMember,
    "PATCH",
    body,
  );
};
