import { afterEach, expect, it } from "vitest";
import { registerVerifiedUser } from "../src/auth/user-registration.ts";
import { migrateDatabase, openDatabase } from "../src/database/database.ts";
import {
  organizationAuditEvents,
  organizationMemberships,
  organizations,
  users,
} from "../src/database/schema.ts";

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

it("registers a long user ID and short organization ID atomically and reuses them on login", () => {
  const database = openDatabase(":memory:");
  databases.push(database);
  migrateDatabase(database);
  const register = () =>
    database.db.transaction((transaction) =>
      registerVerifiedUser(transaction, "identity@example.test", 1000),
    );
  const user = register();
  const organization = database.db.select().from(organizations).get()!;
  const membership = database.db.select().from(organizationMemberships).get()!;

  expect(user.id).toMatch(/^[A-Za-z0-9]{21}$/);
  expect(organization.id).toMatch(/^[A-Za-z0-9]{12}$/);
  expect(membership.id).toMatch(/^[A-Za-z0-9]{21}$/);
  expect(membership).toMatchObject({
    userId: user.id,
    organizationId: organization.id,
    role: "owner",
    isDefault: true,
  });
  expect(database.db.select().from(organizationAuditEvents).all()).toMatchObject([
    { organizationId: organization.id, targetId: organization.id, kind: "organization-created" },
  ]);
  expect(register()).toEqual(user);
  expect(database.db.select().from(users).all()).toHaveLength(1);
  expect(database.db.select().from(organizations).all()).toHaveLength(1);
  expect(database.db.select().from(organizationMemberships).all()).toHaveLength(1);
});
