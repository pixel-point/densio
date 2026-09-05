import { defineProblem, makeDescriptorProblem } from "../../errors/problem-details.ts";
import {
  OrganizationError,
  type OrganizationErrorCode,
} from "../../organizations/organization-errors.ts";

const descriptors = {
  ORGANIZATION_NOT_FOUND: [404, "Organization not found"],
  ORGANIZATION_ACCESS_DENIED: [403, "Organization permission denied"],
  ORGANIZATION_NOT_ACTIVE: [409, "Organization is not active"],
  ORGANIZATION_OWNER_REQUIRED: [403, "Organization owner required"],
  ORGANIZATION_OWNER_TRANSFER_REQUIRED: [409, "Ownership transfer required"],
  ORGANIZATION_MEMBER_NOT_FOUND: [404, "Organization member not found"],
  ORGANIZATION_INVITATION_CONFLICT: [
    409,
    "Invitation conflicts with existing membership or invitation",
  ],
  ORGANIZATION_INVITATION_NOT_FOUND: [404, "Invitation not found"],
  ORGANIZATION_INVITATION_EXPIRED: [410, "Invitation expired"],
  ORGANIZATION_INVITATION_UNAVAILABLE: [409, "Invitation no longer available"],
  ORGANIZATION_RATE_LIMITED: [429, "Organization operation rate limited"],
  ORGANIZATION_DELETION_BLOCKED: [409, "Organization deletion blocked"],
  ORGANIZATION_BILLING_BUSY: [409, "Organization billing operation in progress"],
  IDEMPOTENCY_CONFLICT: [409, "Idempotency key conflict"],
  INVALID_REQUEST: [400, "Invalid organization request"],
} as const satisfies Record<OrganizationErrorCode, readonly [number, string]>;

export const organizationProblemDescriptor = (code: OrganizationErrorCode) =>
  defineProblem({
    code,
    status: descriptors[code][0],
    title: descriptors[code][1],
    description: descriptors[code][1],
  });
export const organizationProblem = (error: unknown) =>
  error instanceof OrganizationError
    ? makeDescriptorProblem(organizationProblemDescriptor(error.code), {
        detail: error.detail,
        ...(error.details === undefined ? {} : { details: error.details }),
        retryable:
          error.code === "ORGANIZATION_RATE_LIMITED" || error.code === "ORGANIZATION_BILLING_BUSY",
        suggestedAction:
          error.code === "ORGANIZATION_NOT_FOUND"
            ? "List organizations and explicitly choose an accessible organization; never silently switch the spending target."
            : "Check the organization's current role and state, then perform the documented remediation with the required authority.",
      })
    : undefined;
