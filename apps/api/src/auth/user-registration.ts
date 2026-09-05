import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DatabaseTransaction } from "../database/database.ts";
import { users } from "../database/schema.ts";
import { provisionOrganization } from "../organizations/organization-provisioning.ts";

export const registerVerifiedUser = (
  transaction: DatabaseTransaction,
  email: string,
  now: number,
) => {
  const existing = transaction.select().from(users).where(eq(users.email, email)).get();
  if (existing !== undefined) return existing;
  const user = transaction
    .insert(users)
    .values({ createdAt: now, email, id: randomUUID(), updatedAt: now })
    .returning()
    .get();
  provisionOrganization(transaction, {
    userId: user.id,
    email,
    now,
    name: "My organization",
    isDefault: true,
    correlationId: `registration-${user.id}`,
  });
  return user;
};
