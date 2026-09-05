import { randomUUID } from "node:crypto";
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
  const organization = transaction
    .insert(organizations)
    .values({
      id: randomUUID(),
      name: input.name,
      billingEmail: input.email,
      state: "active",
      createdByUserId: input.userId,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning()
    .get();
  const membership = transaction
    .insert(organizationMemberships)
    .values({
      id: randomUUID(),
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
