import type { Organization, OrganizationMember } from "@densio/shared";
import { organizations, organizationMemberships } from "../database/schema.ts";

export const organizationProjection = (row: typeof organizations.$inferSelect): Organization => ({
  organizationId: row.id,
  name: row.name,
  billingEmail: row.billingEmail,
  state: row.state,
  createdByUserId: row.createdByUserId,
  createdAt: new Date(row.createdAt).toISOString(),
  updatedAt: new Date(row.updatedAt).toISOString(),
  ...(row.deletionRequestedAt === null
    ? {}
    : {
        deletion: {
          requestedAt: new Date(row.deletionRequestedAt).toISOString(),
          ...(row.deletedAt === null ? {} : { completedAt: new Date(row.deletedAt).toISOString() }),
          cleanupState:
            row.state === "deleted"
              ? ("complete" as const)
              : row.cleanupError === null
                ? ("pending" as const)
                : ("retrying" as const),
        },
      }),
});
export const memberProjection = (
  row: typeof organizationMemberships.$inferSelect,
  email: string,
): OrganizationMember => ({
  membershipId: row.id,
  organizationId: row.organizationId,
  userId: row.userId,
  email,
  role: row.role,
  isDefault: row.isDefault,
  joinedAt: new Date(row.joinedAt).toISOString(),
});
