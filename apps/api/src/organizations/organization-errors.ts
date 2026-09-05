import { Schema } from "effect";

export const OrganizationErrorCodeSchema = Schema.Literals([
  "ORGANIZATION_NOT_FOUND",
  "ORGANIZATION_ACCESS_DENIED",
  "ORGANIZATION_NOT_ACTIVE",
  "ORGANIZATION_OWNER_REQUIRED",
  "ORGANIZATION_OWNER_TRANSFER_REQUIRED",
  "ORGANIZATION_MEMBER_NOT_FOUND",
  "ORGANIZATION_INVITATION_CONFLICT",
  "ORGANIZATION_INVITATION_NOT_FOUND",
  "ORGANIZATION_INVITATION_EXPIRED",
  "ORGANIZATION_INVITATION_UNAVAILABLE",
  "ORGANIZATION_RATE_LIMITED",
  "ORGANIZATION_DELETION_BLOCKED",
  "ORGANIZATION_BILLING_BUSY",
  "IDEMPOTENCY_CONFLICT",
  "INVALID_REQUEST",
]);
export type OrganizationErrorCode = typeof OrganizationErrorCodeSchema.Type;
export class OrganizationError extends Schema.TaggedErrorClass<OrganizationError>()(
  "OrganizationError",
  {
    code: OrganizationErrorCodeSchema,
    detail: Schema.String,
    details: Schema.optionalKey(Schema.Json),
  },
) {}
export class OrganizationStorageError extends Schema.TaggedErrorClass<OrganizationStorageError>()(
  "OrganizationStorageError",
  {
    cause: Schema.Defect(),
    operation: Schema.String,
  },
) {}
export const organizationFailure = (code: OrganizationErrorCode, detail: string) =>
  new OrganizationError({ code, detail });
