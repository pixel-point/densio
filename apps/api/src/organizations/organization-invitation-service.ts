import { eq } from "drizzle-orm";
import type { Database } from "../database/database.ts";
import { organizations, users } from "../database/schema.ts";
import {
  acceptOrganizationInvitation,
  createOrganizationInvitation,
  revokeOrganizationInvitation,
} from "../database/organization-invitation-repository.ts";
import {
  invitationProjection,
  listOrganizationInvitations,
  listReceivedInvitations,
} from "../database/organization-invitation-query.ts";
import { memberProjection } from "./organization-projections.ts";
import { organizationStorage } from "./organization-service.ts";

export const makeOrganizationInvitationService = (database: Database) => ({
  create: (input: Parameters<typeof createOrganizationInvitation>[1]) =>
    organizationStorage("create-invitation", () =>
      projectInvitation(database, createOrganizationInvitation(database, input), input.now),
    ),
  revoke: (input: Parameters<typeof revokeOrganizationInvitation>[1]) =>
    organizationStorage("revoke-invitation", () =>
      projectInvitation(database, revokeOrganizationInvitation(database, input), input.now),
    ),
  list: (input: Parameters<typeof listOrganizationInvitations>[1]) =>
    organizationStorage("list-invitations", () => listOrganizationInvitations(database, input)),
  received: (input: Parameters<typeof listReceivedInvitations>[1]) =>
    organizationStorage("received-invitations", () => listReceivedInvitations(database, input)),
  accept: (input: Parameters<typeof acceptOrganizationInvitation>[1]) =>
    organizationStorage("accept-invitation", () => {
      const result = acceptOrganizationInvitation(database, input);
      const user = database.db.select().from(users).where(eq(users.id, input.userId)).get();
      if (user === undefined) throw new Error("Invitation accepted by a missing identity.");
      return {
        invitation: projectInvitation(database, result.invitation, input.now),
        membership: memberProjection(result.membership, user.email),
        replayed: result.replayed,
      };
    }),
});
export type OrganizationInvitationService = ReturnType<typeof makeOrganizationInvitationService>;

const projectInvitation = (
  database: Database,
  row: Parameters<typeof invitationProjection>[0],
  now: number,
) => {
  const organization = database.db
    .select()
    .from(organizations)
    .where(eq(organizations.id, row.organizationId))
    .get();
  if (organization === undefined) throw new Error("Invitation references a missing organization.");
  return invitationProjection(row, organization.name, now);
};
