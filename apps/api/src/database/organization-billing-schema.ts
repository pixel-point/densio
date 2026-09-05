import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { organizations } from "./organization-schema.ts";

export const billingReconciliations = sqliteTable("billing_reconciliations", {
  subscriptionId: text("subscription_id").primaryKey(),
  claimId: text("claim_id").notNull(),
});

export const billingOperations = sqliteTable("billing_operations", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id),
  id: text("id").notNull(),
  operation: text("operation", { enum: ["checkout", "portal", "contact", "delete"] }).notNull(),
  requestKey: text("request_key").notNull(),
  leaseToken: text("lease_token").notNull(),
  leaseExpiresAt: integer("lease_expires_at").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const billingCustomerRequests = sqliteTable("billing_customer_requests", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id),
  billingEmail: text("billing_email").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const billingCheckoutAttempts = sqliteTable(
  "billing_checkout_attempts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    idempotencyKey: text("idempotency_key").notNull(),
    plan: text("plan", { enum: ["basic", "pro", "scale"] }).notNull(),
    priceId: text("price_id").notNull(),
    cancelUrl: text("cancel_url").notNull(),
    successUrl: text("success_url").notNull(),
    state: text("state", { enum: ["creating", "open", "complete", "expired"] }).notNull(),
    sessionId: text("session_id"),
    expiresAt: integer("expires_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("billing_checkout_attempts_org_key_unique").on(
      table.organizationId,
      table.idempotencyKey,
    ),
    uniqueIndex("billing_checkout_attempts_live_unique")
      .on(table.organizationId)
      .where(sql`${table.state} in ('creating','open')`),
  ],
);
