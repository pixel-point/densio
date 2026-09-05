import { and, eq } from "drizzle-orm";
import type { ParsedOpaqueToken } from "../auth/opaque-token.ts";
import { registerVerifiedUser } from "../auth/user-registration.ts";
import type { OrganizationInvitationLinks } from "../organizations/organization-invitation-link.ts";
import { organizationFailure } from "../organizations/organization-errors.ts";
import type { Database, DatabaseTransaction } from "./database.ts";
import {
  acceptOrganizationInvitationInTransaction,
  deliverableInvitation,
} from "./organization-invitation-repository.ts";
import {
  organizationInvitations,
  organizationMemberships,
  organizations,
  users,
} from "./schema.ts";

export const inspectOrganizationInvitationLink = (
  db: Database["db"] | DatabaseTransaction,
  links: OrganizationInvitationLinks,
  token: ParsedOpaqueToken,
  now: number,
) => {
  const record = db
    .select({ invitation: organizationInvitations, organization: organizations })
    .from(organizationInvitations)
    .innerJoin(organizations, eq(organizations.id, organizationInvitations.organizationId))
    .where(eq(organizationInvitations.id, token.publicId))
    .get();
  if (record === undefined || !links.verify(token, record.invitation))
    throw organizationFailure(
      "ORGANIZATION_INVITATION_NOT_FOUND",
      "This invitation link is invalid. Ask the sender for a new invitation.",
    );
  const { invitation, organization } = record;
  if (invitation.state === "expired" || invitation.expiresAt <= now)
    throw organizationFailure(
      "ORGANIZATION_INVITATION_EXPIRED",
      "This invitation has expired. Ask the sender for a new invitation.",
    );
  if (organization.state !== "active")
    throw organizationFailure(
      "ORGANIZATION_NOT_ACTIVE",
      "This organization is no longer accepting invitations.",
    );
  if (invitation.state === "accepted") {
    const membership = db
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .innerJoin(users, eq(users.id, organizationMemberships.userId))
      .where(
        and(
          eq(organizationMemberships.id, invitation.acceptedMembershipId ?? ""),
          eq(organizationMemberships.organizationId, invitation.organizationId),
          eq(users.email, invitation.email),
        ),
      )
      .get();
    if (membership !== undefined) return record;
  }
  if (deliverableInvitation(db, invitation.id, now) === undefined)
    throw organizationFailure(
      "ORGANIZATION_INVITATION_UNAVAILABLE",
      "This invitation is no longer available. Ask the sender for a new invitation.",
    );
  return record;
};

export const acceptOrganizationInvitationLink = (
  { db }: Database,
  links: OrganizationInvitationLinks,
  input: { token: ParsedOpaqueToken; now: number; correlationId: string },
) =>
  db.transaction(
    (transaction) => {
      const record = inspectOrganizationInvitationLink(transaction, links, input.token, input.now);
      const user = registerVerifiedUser(transaction, record.invitation.email, input.now);
      acceptOrganizationInvitationInTransaction(transaction, {
        invitationId: record.invitation.id,
        userId: user.id,
        now: input.now,
        correlationId: input.correlationId,
      });
      return record.organization.name;
    },
    { behavior: "immediate" },
  );
