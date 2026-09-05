import { and, asc, eq } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "./database.ts";
import { organizationMemberships, organizations, users } from "./schema.ts";
import { provisionOrganization } from "../organizations/organization-provisioning.ts";

export const findDefaultOrganizationId = (
  db: Database["db"] | DatabaseTransaction,
  userId: string,
) =>
  db
    .select({ id: organizations.id })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
    .where(
      and(
        eq(organizationMemberships.userId, userId),
        eq(organizationMemberships.isDefault, true),
        eq(organizations.state, "active"),
      ),
    )
    .get()?.id;

export const replaceMissingDefault = (
  transaction: DatabaseTransaction,
  input: { userId: string; now: number; correlationId: string },
) => {
  if (findDefaultOrganizationId(transaction, input.userId) !== undefined) return;
  transaction
    .update(organizationMemberships)
    .set({ isDefault: false })
    .where(eq(organizationMemberships.userId, input.userId))
    .run();
  const replacement = transaction
    .select({ membership: organizationMemberships })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
    .where(and(eq(organizationMemberships.userId, input.userId), eq(organizations.state, "active")))
    .orderBy(asc(organizationMemberships.joinedAt), asc(organizationMemberships.id))
    .get();
  if (replacement !== undefined) {
    transaction
      .update(organizationMemberships)
      .set({ isDefault: true })
      .where(eq(organizationMemberships.id, replacement.membership.id))
      .run();
    return;
  }
  const user = transaction.select().from(users).where(eq(users.id, input.userId)).get();
  if (user === undefined) throw new Error("Membership references a missing identity.");
  provisionOrganization(transaction, {
    ...input,
    email: user.email,
    name: "My organization",
    isDefault: true,
    actor: { kind: "system", service: "organization-offboarding" },
  });
};
