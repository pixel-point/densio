import { createHash } from "node:crypto";
import { and, asc, eq, gt } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "./database.ts";
import {
  organizations,
  organizationMemberships,
  organizationCreationRequests,
  organizationInvitations,
  users,
} from "./schema.ts";
import {
  authorizeOrganization,
  type OrganizationActor,
} from "../organizations/organization-access.ts";
import { organizationFailure } from "../organizations/organization-errors.ts";
import { provisionOrganization } from "../organizations/organization-provisioning.ts";
import { appendOrganizationAudit } from "./organization-audit-repository.ts";
import { replaceMissingDefault } from "./organization-membership-repository.ts";

export type OrganizationMutation = {
  readonly actor: OrganizationActor;
  readonly now: number;
  readonly correlationId: string;
};

export const createOrganization = (
  { db }: Database,
  input: {
    userId: string;
    name: string;
    idempotencyKey: string;
    now: number;
    correlationId: string;
    maxCreatesPerDay: number;
  },
) =>
  db.transaction(
    (transaction) => {
      const digest = createHash("sha256")
        .update(JSON.stringify({ operation: "create-organization", name: input.name }))
        .digest("hex");
      const previous = transaction
        .select()
        .from(organizationCreationRequests)
        .where(
          and(
            eq(organizationCreationRequests.userId, input.userId),
            eq(organizationCreationRequests.idempotencyKey, input.idempotencyKey),
          ),
        )
        .get();
      if (previous !== undefined) {
        const context = authorizeOrganization(
          transaction,
          { organizationId: previous.organizationId, userId: input.userId },
          "organization-read",
        );
        if (previous.requestDigest !== digest)
          throw organizationFailure(
            "IDEMPOTENCY_CONFLICT",
            "This creation key identifies different organization details.",
          );
        return {
          organization: context.organization,
          membership: context.membership,
          replayed: true,
        };
      }
      const attempts = transaction
        .select()
        .from(organizationCreationRequests)
        .where(
          and(
            eq(organizationCreationRequests.userId, input.userId),
            gt(organizationCreationRequests.createdAt, input.now - 86_400_000),
          ),
        )
        .orderBy(asc(organizationCreationRequests.createdAt))
        .limit(input.maxCreatesPerDay)
        .all();
      if (attempts.length >= input.maxCreatesPerDay)
        throw organizationFailure(
          "ORGANIZATION_RATE_LIMITED",
          "The rolling organization creation limit has been reached. Retry after the oldest request leaves the 24-hour window.",
        );
      const user = transaction.select().from(users).where(eq(users.id, input.userId)).get();
      if (user === undefined)
        throw organizationFailure(
          "ORGANIZATION_NOT_FOUND",
          "The authenticated identity is unavailable.",
        );
      const result = provisionOrganization(transaction, {
        ...input,
        email: user.email,
        isDefault: false,
      });
      transaction
        .insert(organizationCreationRequests)
        .values({
          userId: input.userId,
          idempotencyKey: input.idempotencyKey,
          requestDigest: digest,
          organizationId: result.organization.id,
          createdAt: input.now,
        })
        .run();
      return { ...result, replayed: false };
    },
    { behavior: "immediate" },
  );

export const renameOrganization = (
  { db }: Database,
  input: OrganizationMutation & { name: string },
) =>
  db.transaction(
    (transaction) => {
      authorizeOrganization(transaction, input.actor, "organization-rename");
      const organization = transaction
        .update(organizations)
        .set({ name: input.name, updatedAt: input.now })
        .where(eq(organizations.id, input.actor.organizationId))
        .returning()
        .get();
      auditMutation(transaction, input, "organization-renamed", organization.id);
      return organization;
    },
    { behavior: "immediate" },
  );

export const setDefaultOrganization = (
  { db }: Database,
  input: { userId: string; organizationId: string; now: number; correlationId: string },
) =>
  db.transaction(
    (transaction) => {
      const context = authorizeOrganization(transaction, input, "organization-read");
      transaction
        .update(organizationMemberships)
        .set({ isDefault: false })
        .where(eq(organizationMemberships.userId, input.userId))
        .run();
      transaction
        .update(organizationMemberships)
        .set({ isDefault: true })
        .where(eq(organizationMemberships.id, context.membershipId))
        .run();
      return { organizationId: input.organizationId };
    },
    { behavior: "immediate" },
  );

export const transferOrganizationOwnership = (
  { db }: Database,
  input: OrganizationMutation & { userId: string },
) =>
  db.transaction(
    (transaction) => {
      authorizeOrganization(transaction, input.actor, "ownership-transfer");
      const target = findMember(transaction, input.actor.organizationId, input.userId);
      if (target.role === "owner") return target;
      transaction
        .update(organizationMemberships)
        .set({ role: "admin" })
        .where(eq(organizationMemberships.id, input.actor.membershipId))
        .run();
      transaction
        .update(organizationMemberships)
        .set({ role: "owner" })
        .where(eq(organizationMemberships.id, target.id))
        .run();
      revokeUnauthorizedInvitations(
        transaction,
        input.actor.organizationId,
        input.actor.userId,
        "admin",
        input.now,
        input.correlationId,
      );
      auditMutation(transaction, input, "ownership-transferred", target.userId);
      return { ...target, role: "owner" as const };
    },
    { behavior: "immediate" },
  );

export const setOrganizationMemberRole = (
  { db }: Database,
  input: OrganizationMutation & { userId: string; role: "admin" | "member" },
) =>
  db.transaction(
    (transaction) => {
      authorizeOrganization(transaction, input.actor, "admins-manage");
      const target = findMember(transaction, input.actor.organizationId, input.userId);
      if (target.role === "owner")
        throw organizationFailure(
          "ORGANIZATION_OWNER_TRANSFER_REQUIRED",
          "Use ownership transfer to change the owner.",
        );
      transaction
        .update(organizationMemberships)
        .set({ role: input.role })
        .where(eq(organizationMemberships.id, target.id))
        .run();
      revokeUnauthorizedInvitations(
        transaction,
        input.actor.organizationId,
        target.userId,
        input.role,
        input.now,
        input.correlationId,
      );
      auditMutation(transaction, input, "member-role-changed", target.userId);
      return { ...target, role: input.role };
    },
    { behavior: "immediate" },
  );

export const removeOrganizationMember = (
  { db }: Database,
  input: OrganizationMutation & { userId: string; leave?: boolean },
) =>
  db.transaction(
    (transaction) => {
      const context = authorizeOrganization(
        transaction,
        input.actor,
        input.leave === true ? "organization-read" : "members-manage",
      );
      if (input.leave === true && input.userId !== input.actor.userId)
        throw organizationFailure(
          "ORGANIZATION_ACCESS_DENIED",
          "Leave only applies to the current membership.",
        );
      const target = transaction
        .select()
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.organizationId, context.organizationId),
            eq(organizationMemberships.userId, input.userId),
          ),
        )
        .get();
      if (target === undefined)
        return {
          organizationId: context.organizationId,
          userId: input.userId,
          removed: true as const,
        };
      if (target.role === "owner")
        throw organizationFailure(
          "ORGANIZATION_OWNER_TRANSFER_REQUIRED",
          "Transfer ownership before the current owner leaves or is removed.",
        );
      if (input.leave !== true && target.role === "admin")
        authorizeOrganization(transaction, input.actor, "admins-manage");
      // Deleting the stable membership also deletes only that membership's access grants.
      transaction
        .delete(organizationMemberships)
        .where(eq(organizationMemberships.id, target.id))
        .run();
      revokeUnauthorizedInvitations(
        transaction,
        context.organizationId,
        target.userId,
        "member",
        input.now,
        input.correlationId,
      );
      replaceMissingDefault(transaction, { ...input, userId: target.userId });
      auditMutation(transaction, input, "member-removed", target.userId);
      return {
        organizationId: context.organizationId,
        userId: target.userId,
        removed: true as const,
      };
    },
    { behavior: "immediate" },
  );

const findMember = (transaction: DatabaseTransaction, organizationId: string, userId: string) => {
  const member = transaction
    .select()
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, organizationId),
        eq(organizationMemberships.userId, userId),
      ),
    )
    .get();
  if (member === undefined)
    throw organizationFailure(
      "ORGANIZATION_MEMBER_NOT_FOUND",
      "The addressed member is not in this organization.",
    );
  return member;
};

const auditMutation = (
  transaction: DatabaseTransaction,
  input: OrganizationMutation,
  kind: Parameters<typeof appendOrganizationAudit>[1]["kind"],
  targetId: string,
) =>
  appendOrganizationAudit(transaction, {
    ...input,
    organizationId: input.actor.organizationId,
    kind,
    actor: { kind: "user", userId: input.actor.userId },
    targetId,
  });

const revokeUnauthorizedInvitations = (
  transaction: DatabaseTransaction,
  organizationId: string,
  userId: string,
  role: "admin" | "member",
  now: number,
  correlationId: string,
) =>
  transaction
    .update(organizationInvitations)
    .set({ state: "revoked", updatedAt: now })
    .where(
      and(
        eq(organizationInvitations.organizationId, organizationId),
        eq(organizationInvitations.invitedByUserId, userId),
        eq(organizationInvitations.state, "pending"),
        role === "admin" ? eq(organizationInvitations.role, "admin") : undefined,
      ),
    )
    .returning({ id: organizationInvitations.id })
    .all()
    .forEach(({ id }) =>
      appendOrganizationAudit(transaction, {
        organizationId,
        kind: "invitation-revoked",
        actor: { kind: "system", service: "organization-permissions" },
        targetId: id,
        now,
        correlationId,
      }),
    );
