import { Schema } from "effect";
import {
  IdentifierSchema,
  IsoTimestampSchema,
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
} from "./common-contracts.ts";

export const OrganizationAuditActorSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("user"), userId: IdentifierSchema }),
  Schema.Struct({ kind: Schema.Literal("platform-operator"), name: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("system"), service: Schema.NonEmptyString }),
]);
export type OrganizationAuditActor = typeof OrganizationAuditActorSchema.Type;
export const OrganizationAuditQuerySchema = Schema.Struct({
  after: Schema.optionalKey(NonNegativeIntegerSchema),
  limit: Schema.optionalKey(PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(100))),
});
export type OrganizationAuditQuery = typeof OrganizationAuditQuerySchema.Type;
export const OrganizationAuditEventKindSchema = Schema.Literals([
  "organization-created",
  "organization-renamed",
  "organization-deletion-requested",
  "organization-deleted",
  "member-joined",
  "member-role-changed",
  "member-removed",
  "ownership-transferred",
  "invitation-created",
  "invitation-revoked",
  "invitation-accepted",
  "billing-contact-changed",
  "billing-checkout-created",
  "billing-portal-created",
  "operator-grant-created",
  "operator-grant-revoked",
]);
export type OrganizationAuditEventKind = typeof OrganizationAuditEventKindSchema.Type;
export const OrganizationAuditEventSchema = Schema.Struct({
  sequence: PositiveIntegerSchema,
  organizationId: IdentifierSchema,
  kind: OrganizationAuditEventKindSchema,
  actor: OrganizationAuditActorSchema,
  targetId: IdentifierSchema,
  occurredAt: IsoTimestampSchema,
  correlationId: IdentifierSchema,
});
export type OrganizationAuditEvent = typeof OrganizationAuditEventSchema.Type;
export const OrganizationAuditPageSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  events: Schema.Array(OrganizationAuditEventSchema),
  nextAfter: NonNegativeIntegerSchema,
});
export type OrganizationAuditPage = typeof OrganizationAuditPageSchema.Type;
