import { randomUUID } from "node:crypto";
import { and, eq, gt, lte } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "./database.ts";
import {
  emailOutbox,
  organizations,
  organizationInvitations,
  organizationMemberships,
  users,
} from "./schema.ts";
import type { OrganizationMutation } from "./organization-repository.ts";
import { appendOrganizationAudit } from "./organization-audit-repository.ts";
import { authorizeOrganization } from "../organizations/organization-access.ts";
import { organizationFailure } from "../organizations/organization-errors.ts";

export const createOrganizationInvitation = (
  { db }: Database,
  input: OrganizationMutation & {
    email: string;
    role: "admin" | "member";
    maxInvitationsPerHour: number;
  },
) =>
  db.transaction(
    (transaction) => {
      const context = authorizeOrganization(
        transaction,
        input.actor,
        input.role === "admin" ? "admins-manage" : "members-manage",
      );
      const email = input.email.trim().toLowerCase();
      const previous = pendingInvitationForRecipient(
        transaction,
        context.organizationId,
        email,
        input.now,
      );
      if (previous !== undefined) {
        if (previous.role !== input.role)
          throw organizationFailure(
            "ORGANIZATION_INVITATION_CONFLICT",
            "Revoke the pending invitation before changing its role.",
          );
        return previous;
      }
      const attempts = transaction
        .select({ id: organizationInvitations.id })
        .from(organizationInvitations)
        .where(
          and(
            eq(organizationInvitations.organizationId, context.organizationId),
            gt(organizationInvitations.createdAt, input.now - 3_600_000),
          ),
        )
        .limit(input.maxInvitationsPerHour)
        .all();
      if (attempts.length >= input.maxInvitationsPerHour)
        throw organizationFailure(
          "ORGANIZATION_RATE_LIMITED",
          "The organization's rolling hourly invitation limit has been reached.",
        );
      const invitation = transaction
        .insert(organizationInvitations)
        .values({
          id: randomUUID(),
          organizationId: context.organizationId,
          email,
          role: input.role,
          state: "pending",
          invitedByUserId: context.userId,
          expiresAt: input.now + 7 * 86_400_000,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning()
        .get();
      transaction
        .insert(emailOutbox)
        .values({
          id: randomUUID(),
          resourceKey: `organization-invitation:${invitation.id}`,
          recipient: email,
          payloadJson: JSON.stringify({
            kind: "organization-invitation",
            invitationId: invitation.id,
          }),
          status: "pending",
          createdAt: input.now,
          nextAttemptAt: input.now,
        })
        .run();
      appendOrganizationAudit(transaction, {
        ...input,
        organizationId: context.organizationId,
        kind: "invitation-created",
        actor: { kind: "user", userId: context.userId },
        targetId: invitation.id,
      });
      return invitation;
    },
    { behavior: "immediate" },
  );

export const acceptOrganizationInvitation = (
  { db }: Database,
  input: { invitationId: string; userId: string; now: number; correlationId: string },
) =>
  db.transaction(
    (transaction) => {
      const user = transaction.select().from(users).where(eq(users.id, input.userId)).get();
      const invitation = transaction
        .select()
        .from(organizationInvitations)
        .where(eq(organizationInvitations.id, input.invitationId))
        .get();
      if (user === undefined || invitation === undefined || user.email !== invitation.email)
        throw organizationFailure(
          "ORGANIZATION_INVITATION_NOT_FOUND",
          "No invitation is addressed to this authenticated email.",
        );
      const organization = transaction
        .select()
        .from(organizations)
        .where(eq(organizations.id, invitation.organizationId))
        .get();
      if (organization?.state !== "active")
        throw organizationFailure(
          "ORGANIZATION_NOT_ACTIVE",
          "The invitation's organization is no longer active.",
        );
      if (invitation.state === "accepted") {
        const membership = acceptedInvitationMembership(transaction, invitation, input.userId);
        return { invitation, membership, replayed: true };
      }
      if (invitation.state === "revoked")
        throw organizationFailure(
          "ORGANIZATION_INVITATION_UNAVAILABLE",
          "This invitation was revoked.",
        );
      if (invitation.state === "expired" || invitation.expiresAt <= input.now)
        throw organizationFailure(
          "ORGANIZATION_INVITATION_EXPIRED",
          "This invitation has expired; request a new invitation.",
        );
      if (!inviterCanGrant(transaction, invitation))
        throw organizationFailure(
          "ORGANIZATION_INVITATION_UNAVAILABLE",
          "The inviter can no longer grant this membership.",
        );
      const existing = transaction
        .select()
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.organizationId, invitation.organizationId),
            eq(organizationMemberships.userId, input.userId),
          ),
        )
        .get();
      if (existing !== undefined)
        throw organizationFailure(
          "ORGANIZATION_INVITATION_CONFLICT",
          "You are already a member of this organization.",
        );
      const membership = transaction
        .insert(organizationMemberships)
        .values({
          id: randomUUID(),
          organizationId: invitation.organizationId,
          userId: input.userId,
          role: invitation.role,
          isDefault: false,
          joinedAt: input.now,
        })
        .returning()
        .get();
      const accepted = transaction
        .update(organizationInvitations)
        .set({ state: "accepted", acceptedMembershipId: membership.id, updatedAt: input.now })
        .where(eq(organizationInvitations.id, invitation.id))
        .returning()
        .get();
      appendOrganizationAudit(transaction, {
        ...input,
        organizationId: invitation.organizationId,
        kind: "invitation-accepted",
        actor: { kind: "user", userId: input.userId },
        targetId: invitation.id,
      });
      appendOrganizationAudit(transaction, {
        ...input,
        organizationId: invitation.organizationId,
        kind: "member-joined",
        actor: { kind: "user", userId: input.userId },
        targetId: membership.id,
      });
      return { invitation: accepted, membership, replayed: false };
    },
    { behavior: "immediate" },
  );

export const revokeOrganizationInvitation = (
  { db }: Database,
  input: OrganizationMutation & { invitationId: string },
) =>
  db.transaction(
    (transaction) => {
      authorizeOrganization(transaction, input.actor, "members-manage");
      const invitation = transaction
        .select()
        .from(organizationInvitations)
        .where(
          and(
            eq(organizationInvitations.id, input.invitationId),
            eq(organizationInvitations.organizationId, input.actor.organizationId),
          ),
        )
        .get();
      if (invitation === undefined)
        throw organizationFailure(
          "ORGANIZATION_INVITATION_NOT_FOUND",
          "This invitation is not in the addressed organization.",
        );
      if (invitation.role === "admin")
        authorizeOrganization(transaction, input.actor, "admins-manage");
      if (invitation.state === "revoked") return invitation;
      if (invitation.state === "accepted")
        throw organizationFailure(
          "ORGANIZATION_INVITATION_CONFLICT",
          "The invitation was accepted. Remove the membership explicitly instead.",
        );
      const revoked = transaction
        .update(organizationInvitations)
        .set({ state: "revoked", updatedAt: input.now })
        .where(eq(organizationInvitations.id, invitation.id))
        .returning()
        .get();
      appendOrganizationAudit(transaction, {
        ...input,
        organizationId: invitation.organizationId,
        kind: "invitation-revoked",
        actor: { kind: "user", userId: input.actor.userId },
        targetId: invitation.id,
      });
      return revoked;
    },
    { behavior: "immediate" },
  );

export const deliverableInvitation = (
  db: Database["db"] | DatabaseTransaction,
  invitationId: string,
  now: number,
) => {
  const row = db
    .select({ invitation: organizationInvitations, organization: organizations })
    .from(organizationInvitations)
    .innerJoin(organizations, eq(organizations.id, organizationInvitations.organizationId))
    .where(eq(organizationInvitations.id, invitationId))
    .get();
  return row !== undefined &&
    row.organization.state === "active" &&
    row.invitation.state === "pending" &&
    row.invitation.expiresAt > now &&
    inviterCanGrant(db, row.invitation)
    ? row
    : undefined;
};

const inviterCanGrant = (
  db: Database["db"] | DatabaseTransaction,
  invitation: typeof organizationInvitations.$inferSelect,
) => {
  const inviter = db
    .select()
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, invitation.organizationId),
        eq(organizationMemberships.userId, invitation.invitedByUserId),
      ),
    )
    .get();
  return inviter?.role === "owner" || (inviter?.role === "admin" && invitation.role === "member");
};

const pendingInvitationForRecipient = (
  transaction: DatabaseTransaction,
  organizationId: string,
  email: string,
  now: number,
) => {
  const member = transaction
    .select({ id: organizationMemberships.id })
    .from(organizationMemberships)
    .innerJoin(users, eq(users.id, organizationMemberships.userId))
    .where(and(eq(organizationMemberships.organizationId, organizationId), eq(users.email, email)))
    .get();
  if (member !== undefined)
    throw organizationFailure(
      "ORGANIZATION_INVITATION_CONFLICT",
      "The recipient is already an organization member.",
    );
  transaction
    .update(organizationInvitations)
    .set({ state: "expired", updatedAt: now })
    .where(
      and(
        eq(organizationInvitations.organizationId, organizationId),
        eq(organizationInvitations.email, email),
        eq(organizationInvitations.state, "pending"),
        lte(organizationInvitations.expiresAt, now),
      ),
    )
    .run();
  return transaction
    .select()
    .from(organizationInvitations)
    .where(
      and(
        eq(organizationInvitations.organizationId, organizationId),
        eq(organizationInvitations.email, email),
        eq(organizationInvitations.state, "pending"),
      ),
    )
    .get();
};

const acceptedInvitationMembership = (
  transaction: DatabaseTransaction,
  invitation: typeof organizationInvitations.$inferSelect,
  userId: string,
) => {
  const membership = transaction
    .select()
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.id, invitation.acceptedMembershipId ?? ""),
        eq(organizationMemberships.userId, userId),
        eq(organizationMemberships.organizationId, invitation.organizationId),
      ),
    )
    .get();
  if (membership === undefined)
    throw organizationFailure(
      "ORGANIZATION_INVITATION_UNAVAILABLE",
      "This invitation was already used; a new invitation is required after removal.",
    );
  return membership;
};
