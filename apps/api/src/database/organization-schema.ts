import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./identity-schema.ts";

export const organizations = sqliteTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    billingEmail: text("billing_email").notNull(),
    state: text("state", { enum: ["active", "deleting", "deleted"] }).notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletionRequestedAt: integer("deletion_requested_at"),
    deletedAt: integer("deleted_at"),
    cleanupError: text("cleanup_error"),
  },
  (table) => [
    check("organizations_state_check", sql`${table.state} in ('active','deleting','deleted')`),
    index("organizations_state_created_index").on(table.state, table.createdAt, table.id),
  ],
);

export const organizationMemberships = sqliteTable(
  "organization_memberships",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role", { enum: ["owner", "admin", "member"] }).notNull(),
    isDefault: integer("is_default", { mode: "boolean" }).notNull(),
    joinedAt: integer("joined_at").notNull(),
  },
  (table) => [
    check("organization_memberships_role_check", sql`${table.role} in ('owner','admin','member')`),
    uniqueIndex("organization_memberships_org_user_unique").on(table.organizationId, table.userId),
    uniqueIndex("organization_memberships_owner_unique")
      .on(table.organizationId)
      .where(sql`${table.role} = 'owner'`),
    uniqueIndex("organization_memberships_default_unique")
      .on(table.userId)
      .where(sql`${table.isDefault} = 1`),
    index("organization_memberships_user_joined_index").on(table.userId, table.joinedAt, table.id),
  ],
);

export const organizationAuditEvents = sqliteTable(
  "organization_audit_events",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    kind: text("kind").notNull(),
    actorJson: text("actor_json").notNull(),
    targetId: text("target_id").notNull(),
    occurredAt: integer("occurred_at").notNull(),
    correlationId: text("correlation_id").notNull(),
  },
  (table) => [index("organization_audit_sequence_index").on(table.organizationId, table.sequence)],
);

export const organizationCreationRequests = sqliteTable(
  "organization_creation_requests",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("organization_creation_requests_key_unique").on(table.userId, table.idempotencyKey),
    index("organization_creation_requests_rate_index").on(table.userId, table.createdAt),
  ],
);

export const organizationInvitations = sqliteTable(
  "organization_invitations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    email: text("email").notNull(),
    role: text("role", { enum: ["admin", "member"] }).notNull(),
    state: text("state", { enum: ["pending", "accepted", "revoked", "expired"] }).notNull(),
    invitedByUserId: text("invited_by_user_id")
      .notNull()
      .references(() => users.id),
    acceptedMembershipId: text("accepted_membership_id"),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("organization_invitations_pending_unique")
      .on(table.organizationId, table.email)
      .where(sql`${table.state} = 'pending'`),
    index("organization_invitations_recipient_index").on(table.email, table.createdAt, table.id),
    index("organization_invitations_org_created_index").on(
      table.organizationId,
      table.createdAt,
      table.id,
    ),
  ],
);
