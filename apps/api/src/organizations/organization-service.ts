import { Effect } from "effect";
import type { Database } from "../database/database.ts";
import { users } from "../database/schema.ts";
import { eq } from "drizzle-orm";
import {
  createOrganization,
  renameOrganization,
  setDefaultOrganization,
  transferOrganizationOwnership,
  setOrganizationMemberRole,
  removeOrganizationMember,
} from "../database/organization-repository.ts";
import {
  getOrganization,
  listOrganizations,
  listOrganizationMembers,
  listOrganizationAudit,
} from "../database/organization-query-repository.ts";
import { authorizeOrganization } from "./organization-access.ts";
import { memberProjection, organizationProjection } from "./organization-projections.ts";
import { OrganizationError, OrganizationStorageError } from "./organization-errors.ts";

export const organizationStorage = Effect.fn("Organization.storage")(
  <Value>(operation: string, evaluate: () => Value) =>
    Effect.try({
      try: evaluate,
      catch: (cause) =>
        cause instanceof OrganizationError
          ? cause
          : new OrganizationStorageError({ operation, cause }),
    }),
);

export const makeOrganizationService = (database: Database) => ({
  authorize: (
    ...args: Parameters<typeof authorizeOrganization> extends [unknown, ...infer Rest]
      ? Rest
      : never
  ) => organizationStorage("authorize", () => authorizeOrganization(database.db, ...args)),
  get: (input: Parameters<typeof getOrganization>[1]) =>
    organizationStorage("get", () => getOrganization(database, input)),
  list: (input: Parameters<typeof listOrganizations>[1]) =>
    organizationStorage("list", () => listOrganizations(database, input)),
  listMembers: (input: Parameters<typeof listOrganizationMembers>[1]) =>
    organizationStorage("list-members", () => listOrganizationMembers(database, input)),
  audit: (input: Parameters<typeof listOrganizationAudit>[1]) =>
    organizationStorage("audit", () => listOrganizationAudit(database, input)),
  create: (input: Parameters<typeof createOrganization>[1]) =>
    organizationStorage("create", () => {
      const result = createOrganization(database, input);
      return {
        ...getOrganization(database, {
          userId: input.userId,
          organizationId: result.organization.id,
        }),
        replayed: result.replayed,
      };
    }),
  rename: (input: Parameters<typeof renameOrganization>[1]) =>
    organizationStorage("rename", () =>
      organizationProjection(renameOrganization(database, input)),
    ),
  setDefault: (input: Parameters<typeof setDefaultOrganization>[1]) =>
    organizationStorage("set-default", () => setDefaultOrganization(database, input)),
  transfer: (input: Parameters<typeof transferOrganizationOwnership>[1]) =>
    organizationStorage("transfer", () =>
      projectMember(database, transferOrganizationOwnership(database, input)),
    ),
  setRole: (input: Parameters<typeof setOrganizationMemberRole>[1]) =>
    organizationStorage("set-role", () =>
      projectMember(database, setOrganizationMemberRole(database, input)),
    ),
  removeMember: (input: Parameters<typeof removeOrganizationMember>[1]) =>
    organizationStorage("remove-member", () => removeOrganizationMember(database, input)),
});
export type OrganizationService = ReturnType<typeof makeOrganizationService>;

const projectMember = (database: Database, row: Parameters<typeof memberProjection>[0]) => {
  const user = database.db.select().from(users).where(eq(users.id, row.userId)).get();
  if (user === undefined) throw new Error("Membership references a missing identity.");
  return memberProjection(row, user.email);
};
