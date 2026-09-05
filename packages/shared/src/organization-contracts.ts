import { Schema } from "effect";
import { EmailAddressSchema } from "./auth-contracts.ts";
import { HttpUrlSchema, IdentifierSchema, IsoTimestampSchema } from "./common-contracts.ts";

export const OrganizationRoleSchema = Schema.Literals(["owner", "admin", "member"]);
export type OrganizationRole = typeof OrganizationRoleSchema.Type;
export const OrganizationOperationSchema = Schema.Literals([
  "storage-configure",
  "organization-read",
  "organization-rename",
  "members-read",
  "members-manage",
  "admins-manage",
  "invitations-read",
  "audit-read",
  "media-read",
  "media-write",
  "billing-read",
  "billing-write",
  "ownership-transfer",
  "organization-delete",
]);
export type OrganizationOperation = typeof OrganizationOperationSchema.Type;
export const OrganizationStateSchema = Schema.Literals(["active", "deleting", "deleted"]);
export type OrganizationState = typeof OrganizationStateSchema.Type;
export const OrganizationNameSchema = Schema.NonEmptyString.check(
  Schema.isMaxLength(100),
  Schema.isPattern(/\S/),
);
export const OrganizationCreateRequestSchema = Schema.Struct({ name: OrganizationNameSchema });
export type OrganizationCreateRequest = typeof OrganizationCreateRequestSchema.Type;
export const OrganizationRenameRequestSchema = Schema.Struct({ name: OrganizationNameSchema });
export type OrganizationRenameRequest = typeof OrganizationRenameRequestSchema.Type;
export const OrganizationMemberRoleRequestSchema = Schema.Struct({
  role: Schema.Literals(["admin", "member"]),
});
export type OrganizationMemberRoleRequest = typeof OrganizationMemberRoleRequestSchema.Type;
export const OrganizationTransferRequestSchema = Schema.Struct({ userId: IdentifierSchema });
export type OrganizationTransferRequest = typeof OrganizationTransferRequestSchema.Type;
export const DefaultOrganizationRequestSchema = Schema.Struct({ organizationId: IdentifierSchema });
export type DefaultOrganizationRequest = typeof DefaultOrganizationRequestSchema.Type;

export const OrganizationSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  name: OrganizationNameSchema,
  billingEmail: EmailAddressSchema,
  state: OrganizationStateSchema,
  createdByUserId: IdentifierSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  deletion: Schema.optionalKey(
    Schema.Struct({
      requestedAt: IsoTimestampSchema,
      completedAt: Schema.optionalKey(IsoTimestampSchema),
      cleanupState: Schema.Literals(["pending", "retrying", "complete"]),
    }),
  ),
});
export type Organization = typeof OrganizationSchema.Type;

export const OrganizationMemberSchema = Schema.Struct({
  membershipId: IdentifierSchema,
  organizationId: IdentifierSchema,
  userId: IdentifierSchema,
  email: EmailAddressSchema,
  role: OrganizationRoleSchema,
  joinedAt: IsoTimestampSchema,
  isDefault: Schema.Boolean,
});
export type OrganizationMember = typeof OrganizationMemberSchema.Type;

export const OrganizationDirectoryQuerySchema = Schema.Struct({
  limit: Schema.optionalKey(
    Schema.Finite.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 })),
  ),
  cursor: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(2_000))),
});
export type OrganizationDirectoryQuery = typeof OrganizationDirectoryQuerySchema.Type;
export const OrganizationListQuerySchema = Schema.Struct({
  ...OrganizationDirectoryQuerySchema.fields,
  state: Schema.optionalKey(OrganizationStateSchema),
});
export type OrganizationListQuery = typeof OrganizationListQuerySchema.Type;
export const OrganizationMembershipSchema = Schema.Struct({
  organization: OrganizationSchema,
  membership: OrganizationMemberSchema,
});
export type OrganizationMembership = typeof OrganizationMembershipSchema.Type;
export const OrganizationListResponseSchema = Schema.Struct({
  organizations: Schema.Array(OrganizationMembershipSchema),
  nextCursor: Schema.optionalKey(Schema.NonEmptyString),
});
export type OrganizationListResponse = typeof OrganizationListResponseSchema.Type;
export const OrganizationMembersResponseSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  members: Schema.Array(OrganizationMemberSchema),
  nextCursor: Schema.optionalKey(Schema.NonEmptyString),
});
export type OrganizationMembersResponse = typeof OrganizationMembersResponseSchema.Type;
export const OrganizationCreateResponseSchema = Schema.Struct({
  ...OrganizationMembershipSchema.fields,
  replayed: Schema.Boolean,
});
export type OrganizationCreateResponse = typeof OrganizationCreateResponseSchema.Type;
export const OrganizationMemberRemovalSchema = Schema.Struct({
  organizationId: IdentifierSchema,
  userId: IdentifierSchema,
  removed: Schema.Literal(true),
});
export type OrganizationMemberRemoval = typeof OrganizationMemberRemovalSchema.Type;

const DeletionReceiptFields = {
  organizationId: IdentifierSchema,
  requestedAt: IsoTimestampSchema,
  statusUrl: HttpUrlSchema,
};
export const OrganizationDeletionReceiptSchema = Schema.Union([
  Schema.Struct({ ...DeletionReceiptFields, state: Schema.Literal("deleting") }),
  Schema.Struct({
    ...DeletionReceiptFields,
    state: Schema.Literal("deleted"),
    completedAt: IsoTimestampSchema,
  }),
]);
export type OrganizationDeletionReceipt = typeof OrganizationDeletionReceiptSchema.Type;
