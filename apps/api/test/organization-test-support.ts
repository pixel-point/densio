import { randomUUID } from "node:crypto";
import type { OrganizationRole } from "@densio/shared";
import { migrateDatabase, openDatabase } from "../src/database/database.ts";
import { organizationMemberships, users } from "../src/database/schema.ts";
import { provisionOrganization } from "../src/organizations/organization-provisioning.ts";

export const organizationNow = Date.UTC(2026, 8, 4);
export const organizationFixture = (databasePath = ":memory:") => {
  const database = openDatabase(databasePath);
  migrateDatabase(database);
  database.db
    .insert(users)
    .values(
      ["owner", "admin", "member", "outsider"].map((id) => ({
        id,
        email: `${id}@example.test`,
        createdAt: organizationNow,
        updatedAt: organizationNow,
      })),
    )
    .run();
  const provision = (userId: string) =>
    database.db.transaction((transaction) =>
      provisionOrganization(transaction, {
        userId,
        email: `${userId}@example.test`,
        now: organizationNow,
        name: "My organization",
        isDefault: true,
        correlationId: "test-signup",
      }),
    );
  const team = provision("owner");
  const outside = provision("outsider");
  const join = (userId: string, role: OrganizationRole, isDefault = true) =>
    database.db
      .insert(organizationMemberships)
      .values({
        id: randomUUID(),
        organizationId: team.organization.id,
        userId,
        role,
        isDefault,
        joinedAt: organizationNow,
      })
      .returning()
      .get();
  const admin = join("admin", "admin");
  const member = join("member", "member");
  return { database, team, outside, admin, member, organizationId: team.organization.id };
};
