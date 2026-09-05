import { and, eq } from "drizzle-orm";
import type { Database } from "../src/database/database.ts";
import { organizationMemberships, organizations, users } from "../src/database/schema.ts";

export const fixtureOrganizationActor = {
  organizationId: "org-1",
  userId: "user-1",
  membershipId: "membership-org-1-user-1",
} as const;
export const otherFixtureOrganizationActor = {
  organizationId: "org-2",
  userId: "user-2",
  membershipId: "membership-org-2-user-2",
} as const;

export const ensureOrganizationActor = (
  database: Database,
  organizationId = "org-1",
  userId = "user-1",
) => {
  database.db
    .insert(users)
    .values({ id: userId, email: `${userId}@example.test`, createdAt: 1, updatedAt: 1 })
    .onConflictDoNothing()
    .run();
  database.db
    .insert(organizations)
    .values({
      id: organizationId,
      name: organizationId,
      billingEmail: `${userId}@example.test`,
      state: "active",
      createdByUserId: userId,
      createdAt: 1,
      updatedAt: 1,
    })
    .onConflictDoNothing()
    .run();
  const existingDefault = database.db
    .select()
    .from(organizationMemberships)
    .where(
      and(eq(organizationMemberships.userId, userId), eq(organizationMemberships.isDefault, true)),
    )
    .get();
  const owner = database.db
    .select()
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, organizationId),
        eq(organizationMemberships.role, "owner"),
      ),
    )
    .get();
  database.db
    .insert(organizationMemberships)
    .values({
      id: `membership-${organizationId}-${userId}`,
      organizationId,
      userId,
      role: owner === undefined ? "owner" : "member",
      isDefault: existingDefault === undefined,
      joinedAt: 1,
    })
    .onConflictDoNothing()
    .run();
  const membership = database.db
    .select()
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, organizationId),
        eq(organizationMemberships.userId, userId),
      ),
    )
    .get();
  if (membership === undefined) throw new Error("Test membership was not created.");
  return { organizationId, userId, membershipId: membership.id };
};
