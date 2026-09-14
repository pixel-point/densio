import { createId, createOrganizationId } from "../identifiers.ts";
import type { OrganizationAuditActor } from "@densio/shared";
import type { DatabaseTransaction } from "../database/database.ts";
import {
  organizations,
  organizationMemberships,
  organizationAuditEvents,
} from "../database/schema.ts";

// The caller owns the transaction so identity, membership, and session commit together.
export const provisionOrganization = (
  transaction: DatabaseTransaction,
  input: {
    userId: string;
    email: string;
    now: number;
    name: string;
    isDefault: boolean;
    correlationId: string;
    actor?: OrganizationAuditActor;
  },
) => {
  const organization = allocateOrganization(transaction, {
    name: input.name,
    billingEmail: input.email,
    state: "active",
    createdByUserId: input.userId,
    createdAt: input.now,
    updatedAt: input.now,
  });
  const membership = transaction
    .insert(organizationMemberships)
    .values({
      id: createId(),
      organizationId: organization.id,
      userId: input.userId,
      role: "owner",
      isDefault: input.isDefault,
      joinedAt: input.now,
    })
    .returning()
    .get();
  transaction
    .insert(organizationAuditEvents)
    .values({
      organizationId: organization.id,
      kind: "organization-created",
      actorJson: JSON.stringify(input.actor ?? { kind: "user", userId: input.userId }),
      targetId: organization.id,
      occurredAt: input.now,
      correlationId: input.correlationId,
    })
    .run();
  return { organization, membership };
};

const allocateOrganization = (
  transaction: DatabaseTransaction,
  values: Omit<typeof organizations.$inferInsert, "id">,
) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const organization = transaction
      .insert(organizations)
      .values({ ...values, id: createOrganizationId() })
      // Only an ID collision can be retried; other constraint failures must roll back.
      .onConflictDoNothing({ target: organizations.id })
      .returning()
      .get();
    if (organization !== undefined) return organization;
  }
  throw new Error("Unable to allocate an organization ID after 3 attempts.");
};
