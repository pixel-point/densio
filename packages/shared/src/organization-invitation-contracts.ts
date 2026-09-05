import { Schema } from "effect";
import { EmailAddressSchema } from "./auth-contracts.ts";
import { IdentifierSchema, IsoTimestampSchema } from "./common-contracts.ts";
import {
  OrganizationDirectoryQuerySchema,
  OrganizationMemberSchema,
  OrganizationNameSchema,
} from "./organization-contracts.ts";

export const OrganizationInvitationCreateRequestSchema = Schema.Struct({
  email: EmailAddressSchema,
  role: Schema.Literals(["member", "admin"]),
});
export type OrganizationInvitationCreateRequest =
  typeof OrganizationInvitationCreateRequestSchema.Type;
export const OrganizationInvitationStateSchema = Schema.Literals([
  "pending",
  "accepted",
  "revoked",
  "expired",
]);
export type OrganizationInvitationState = typeof OrganizationInvitationStateSchema.Type;
export const OrganizationInvitationSchema = Schema.Struct({
  invitationId: IdentifierSchema,
  organizationId: IdentifierSchema,
  organizationName: OrganizationNameSchema,
  email: EmailAddressSchema,
  role: Schema.Literals(["member", "admin"]),
  state: OrganizationInvitationStateSchema,
  invitedByUserId: IdentifierSchema,
  createdAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
});
export type OrganizationInvitation = typeof OrganizationInvitationSchema.Type;
export const OrganizationInvitationListQuerySchema = Schema.Struct({
  ...OrganizationDirectoryQuerySchema.fields,
  state: Schema.optionalKey(OrganizationInvitationStateSchema),
});
export type OrganizationInvitationListQuery = typeof OrganizationInvitationListQuerySchema.Type;
export const ReceivedInvitationsResponseSchema = Schema.Struct({
  invitations: Schema.Array(OrganizationInvitationSchema),
  nextCursor: Schema.optionalKey(Schema.NonEmptyString),
});
export type ReceivedInvitationsResponse = typeof ReceivedInvitationsResponseSchema.Type;
export const OrganizationInvitationsResponseSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  ...ReceivedInvitationsResponseSchema.fields,
});
export type OrganizationInvitationsResponse = typeof OrganizationInvitationsResponseSchema.Type;
export const OrganizationInvitationAcceptResponseSchema = Schema.Struct({
  invitation: OrganizationInvitationSchema,
  membership: OrganizationMemberSchema,
  replayed: Schema.Boolean,
});
export type OrganizationInvitationAcceptResponse =
  typeof OrganizationInvitationAcceptResponseSchema.Type;
