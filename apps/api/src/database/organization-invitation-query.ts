import type { OrganizationInvitation, OrganizationInvitationListQuery } from "@densio/shared";
import { and, asc, eq, gt, lte, or, sql } from "drizzle-orm";
import type { Database } from "./database.ts";
import { organizationInvitations, organizations, users } from "./schema.ts";
import { directoryNextCursor, readDirectoryCursor } from "./organization-query-repository.ts";
import {
  authorizeOrganization,
  type OrganizationActor,
} from "../organizations/organization-access.ts";
import { organizationFailure } from "../organizations/organization-errors.ts";

export const invitationProjection = (
  row: typeof organizationInvitations.$inferSelect,
  organizationName: string,
  now: number,
): OrganizationInvitation => ({
  invitationId: row.id,
  organizationId: row.organizationId,
  organizationName,
  email: row.email,
  role: row.role,
  state: row.state === "pending" && row.expiresAt <= now ? "expired" : row.state,
  invitedByUserId: row.invitedByUserId,
  createdAt: new Date(row.createdAt).toISOString(),
  expiresAt: new Date(row.expiresAt).toISOString(),
});

export const listOrganizationInvitations = (
  database: Database,
  input: OrganizationInvitationListQuery & { actor: OrganizationActor; now: number },
) => {
  authorizeOrganization(database.db, input.actor, "invitations-read");
  return {
    organizationId: input.actor.organizationId,
    ...invitationPage(
      database,
      input,
      eq(organizationInvitations.organizationId, input.actor.organizationId),
    ),
  };
};
export const listReceivedInvitations = (
  database: Database,
  input: OrganizationInvitationListQuery & { userId: string; now: number },
) => {
  const user = database.db.select().from(users).where(eq(users.id, input.userId)).get();
  if (user === undefined)
    throw organizationFailure(
      "ORGANIZATION_INVITATION_NOT_FOUND",
      "The authenticated recipient is unavailable.",
    );
  return invitationPage(database, input, eq(organizationInvitations.email, user.email));
};

const invitationPage = (
  { db }: Database,
  input: OrganizationInvitationListQuery & { now: number },
  scope: ReturnType<typeof eq>,
) => {
  const cursor = readDirectoryCursor(input.cursor);
  const limit = input.limit ?? 25;
  const state = input.state ?? "pending";
  const stateFilter =
    state === "expired"
      ? or(
          eq(organizationInvitations.state, "expired"),
          and(
            eq(organizationInvitations.state, "pending"),
            lte(organizationInvitations.expiresAt, input.now),
          ),
        )
      : and(
          eq(organizationInvitations.state, state),
          state === "pending" ? gt(organizationInvitations.expiresAt, input.now) : undefined,
        );
  const rows = db
    .select({ invitation: organizationInvitations, name: organizations.name })
    .from(organizationInvitations)
    .innerJoin(organizations, eq(organizations.id, organizationInvitations.organizationId))
    .where(
      and(
        scope,
        stateFilter,
        cursor === undefined
          ? undefined
          : sql`(${organizationInvitations.createdAt}, ${organizationInvitations.id}) > (${cursor.at}, ${cursor.id})`,
      ),
    )
    .orderBy(asc(organizationInvitations.createdAt), asc(organizationInvitations.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page.at(-1)?.invitation;
  return {
    invitations: page.map((row) => invitationProjection(row.invitation, row.name, input.now)),
    ...directoryNextCursor(
      rows.length > limit,
      last === undefined ? undefined : { at: last.createdAt, id: last.id },
    ),
  };
};
