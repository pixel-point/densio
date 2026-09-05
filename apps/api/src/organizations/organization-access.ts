import type { OrganizationOperation, OrganizationRole } from "@densio/shared";
import { and, eq } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../database/database.ts";
import { organizationMemberships, organizations } from "../database/schema.ts";
import { organizationFailure } from "./organization-errors.ts";

const memberOperations = [
  "organization-read",
  "members-read",
  "media-read",
  "media-write",
  "billing-read",
] as const;
const adminOperations = [
  "storage-configure",
  ...memberOperations,
  "organization-rename",
  "members-manage",
  "invitations-read",
  "audit-read",
] as const;
const ownerOperations = [
  ...adminOperations,
  "admins-manage",
  "billing-write",
  "ownership-transfer",
  "organization-delete",
] as const;
const roleOperations: Record<OrganizationRole, readonly OrganizationOperation[]> = {
  member: memberOperations,
  admin: adminOperations,
  owner: ownerOperations,
};
export const organizationOperations = (role: OrganizationRole) => roleOperations[role];

export type OrganizationActor = {
  readonly organizationId: string;
  readonly userId: string;
  readonly membershipId: string;
};

export const authorizeOrganization = (
  db: Database["db"] | DatabaseTransaction,
  identity: {
    readonly organizationId: string;
    readonly userId: string;
    readonly membershipId?: string;
  },
  operation: OrganizationOperation,
  allowClosed = false,
) => {
  const row = db
    .select({ organization: organizations, membership: organizationMemberships })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
    .where(
      and(
        eq(organizationMemberships.organizationId, identity.organizationId),
        eq(organizationMemberships.userId, identity.userId),
      ),
    )
    .get();
  if (
    row === undefined ||
    (identity.membershipId !== undefined && row.membership.id !== identity.membershipId)
  ) {
    throw organizationFailure(
      "ORGANIZATION_NOT_FOUND",
      "This organization is not accessible to the authenticated user.",
    );
  }
  if (row.organization.state !== "active" && !allowClosed) {
    throw organizationFailure(
      "ORGANIZATION_NOT_ACTIVE",
      "The organization is closing or already deleted. New work is not accepted.",
    );
  }
  if (!roleOperations[row.membership.role].includes(operation)) {
    throw organizationFailure(
      !organizationOperations("admin").includes(operation)
        ? "ORGANIZATION_OWNER_REQUIRED"
        : "ORGANIZATION_ACCESS_DENIED",
      "The current membership role does not permit this operation.",
    );
  }
  return {
    ...row,
    organizationId: row.organization.id,
    userId: row.membership.userId,
    membershipId: row.membership.id,
  };
};
