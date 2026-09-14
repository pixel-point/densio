import { afterEach, expect, it, vi } from "vitest";
import { createOrganizationId } from "../src/identifiers.ts";
import { registerVerifiedUser } from "../src/auth/user-registration.ts";
import { createOrganization } from "../src/database/organization-repository.ts";
import {
  organizationAuditEvents,
  organizationCreationRequests,
  organizationMemberships,
  organizations,
  users,
} from "../src/database/schema.ts";
import { provisionOrganization } from "../src/organizations/organization-provisioning.ts";
import { organizationFixture, organizationNow } from "./organization-test-support.ts";

vi.mock("../src/identifiers.ts", { spy: true });

const fixtures: ReturnType<typeof organizationFixture>[] = [];
const setup = () => {
  const fixture = organizationFixture();
  fixtures.push(fixture);
  return fixture;
};
afterEach(() => {
  vi.mocked(createOrganizationId).mockReset();
  fixtures.splice(0).forEach(({ database }) => database.close());
});

it("retries organization ID collisions and persists one replayable organization", () => {
  const fixture = setup();
  const { database } = fixture;
  const previous = snapshot(database);
  vi.mocked(createOrganizationId)
    .mockReturnValueOnce(fixture.organizationId)
    .mockReturnValueOnce(fixture.outside.organization.id)
    .mockReturnValueOnce("A1b2C3d4E5f6");
  const input = {
    userId: "owner",
    name: "New team",
    now: organizationNow + 1,
    correlationId: "collision-test",
    idempotencyKey: "create-team",
    maxCreatesPerDay: 10,
  };

  const created = createOrganization(database, input);

  expect(created.organization.id).toBe("A1b2C3d4E5f6");
  expect(created.membership.organizationId).toBe(created.organization.id);
  expect(createOrganization(database, input)).toMatchObject({
    organization: created.organization,
    membership: created.membership,
    replayed: true,
  });
  const after = snapshot(database);
  expect(after.organizations).toHaveLength(previous.organizations.length + 1);
  expect(after.organizations).toEqual(expect.arrayContaining(previous.organizations));
  expect(after.memberships).toHaveLength(previous.memberships.length + 1);
  expect(after.audit).toHaveLength(previous.audit.length + 1);
  expect(after.requests).toMatchObject([{ organizationId: created.organization.id }]);
});

it("rolls back new registration when organization ID allocation is exhausted", () => {
  const { database, organizationId } = setup();
  const before = snapshot(database);
  vi.mocked(createOrganizationId).mockReturnValue(organizationId);

  expect(() =>
    database.db.transaction((transaction) =>
      registerVerifiedUser(transaction, "new-user@example.test", organizationNow + 1),
    ),
  ).toThrowError("Unable to allocate an organization ID after 3 attempts.");
  expect(snapshot(database)).toEqual(before);
});

it("preserves unrelated constraint errors and rolls back organization membership failures", () => {
  const { database } = setup();
  const before = snapshot(database);
  vi.mocked(createOrganizationId).mockReturnValue("A1b2C3d4E5f6");

  expect(() =>
    database.db.transaction((transaction) =>
      provisionOrganization(transaction, {
        userId: "owner",
        name: "Second default",
        email: "owner@example.test",
        now: organizationNow + 1,
        correlationId: "constraint-test",
        isDefault: true,
      }),
    ),
  ).toThrowError(
    expect.objectContaining({
      cause: expect.objectContaining({
        message: "UNIQUE constraint failed: organization_memberships.user_id",
      }),
    }),
  );
  expect(snapshot(database)).toEqual(before);
});

const snapshot = (database: ReturnType<typeof organizationFixture>["database"]) => ({
  users: database.db.select().from(users).all(),
  organizations: database.db.select().from(organizations).all(),
  memberships: database.db.select().from(organizationMemberships).all(),
  audit: database.db.select().from(organizationAuditEvents).all(),
  requests: database.db.select().from(organizationCreationRequests).all(),
});
