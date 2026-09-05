import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { organizationFixture, organizationNow } from "./organization-test-support.ts";
import { organizationMemberships, organizations } from "../src/database/schema.ts";
import { authorizeOrganization } from "../src/organizations/organization-access.ts";
import {
  createOrganization,
  renameOrganization,
  setDefaultOrganization,
  transferOrganizationOwnership,
  setOrganizationMemberRole,
  removeOrganizationMember,
} from "../src/database/organization-repository.ts";

const fixtures: ReturnType<typeof organizationFixture>[] = [];
const setup = () => {
  const fixture = organizationFixture();
  fixtures.push(fixture);
  return fixture;
};
afterEach(() => fixtures.splice(0).forEach(({ database }) => database.close()));
const mutation = { now: organizationNow + 1, correlationId: "request-test" };

describe("organization management", () => {
  it("distinguishes inaccessible organizations from insufficient roles", () => {
    const { database, organizationId } = setup();
    expect(authorizeOrganization).toBeDefined();
    expect(() =>
      authorizeOrganization(
        database.db,
        { organizationId, userId: "outsider" },
        "organization-read",
      ),
    ).toThrowError(expect.objectContaining({ code: "ORGANIZATION_NOT_FOUND" }));
    expect(() =>
      authorizeOrganization(database.db, { organizationId, userId: "member" }, "billing-write"),
    ).toThrowError(expect.objectContaining({ code: "ORGANIZATION_OWNER_REQUIRED" }));
    expect(
      authorizeOrganization(database.db, { organizationId, userId: "member" }, "media-write"),
    ).toMatchObject({ organizationId, userId: "member" });
  });

  it("creates additional organizations idempotently without switching defaults", () => {
    const { database, organizationId } = setup();
    expect(createOrganization).toBeDefined();
    const input = {
      ...mutation,
      userId: "owner",
      name: "Team 2",
      idempotencyKey: "new-org",
      maxCreatesPerDay: 1,
    };
    const created = createOrganization(database, input);
    expect(created.replayed).toBe(false);
    expect(createOrganization(database, input)).toMatchObject({
      replayed: true,
      organization: created.organization,
    });
    expect(() => createOrganization(database, { ...input, name: "Changed" })).toThrowError(
      expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT" }),
    );
    expect(() => createOrganization(database, { ...input, idempotencyKey: "other" })).toThrowError(
      expect.objectContaining({ code: "ORGANIZATION_RATE_LIMITED" }),
    );
    expect(
      database.db
        .select()
        .from(organizationMemberships)
        .where(eq(organizationMemberships.userId, "owner"))
        .all()
        .find((row) => row.isDefault)?.organizationId,
    ).toBe(organizationId);
  });
});

describe("organization authority and offboarding", () => {
  it("checks current membership again at the mutation boundary", () => {
    const { database, organizationId } = setup();
    expect(authorizeOrganization).toBeDefined();
    const actor = authorizeOrganization(
      database.db,
      { organizationId, userId: "admin" },
      "organization-rename",
    );
    database.db
      .update(organizationMemberships)
      .set({ role: "member" })
      .where(eq(organizationMemberships.id, actor.membershipId))
      .run();
    expect(() =>
      renameOrganization(database, { ...mutation, actor, name: "Stale authority" }),
    ).toThrowError(expect.objectContaining({ code: "ORGANIZATION_ACCESS_DENIED" }));
    expect(
      database.db.select().from(organizations).where(eq(organizations.id, organizationId)).get()
        ?.name,
    ).toBe("My organization");
  });

  it("transfers the sole ownership atomically and blocks owner removal", () => {
    const { database, organizationId } = setup();
    expect(authorizeOrganization).toBeDefined();
    const actor = authorizeOrganization(
      database.db,
      { organizationId, userId: "owner" },
      "ownership-transfer",
    );
    expect(() =>
      removeOrganizationMember(database, { ...mutation, actor, userId: "owner" }),
    ).toThrowError(expect.objectContaining({ code: "ORGANIZATION_OWNER_TRANSFER_REQUIRED" }));
    transferOrganizationOwnership(database, { ...mutation, actor, userId: "member" });
    const members = database.db
      .select()
      .from(organizationMemberships)
      .where(eq(organizationMemberships.organizationId, organizationId))
      .all();
    expect(members.filter((row) => row.role === "owner").map((row) => row.userId)).toEqual([
      "member",
    ]);
    expect(members.find((row) => row.userId === "owner")?.role).toBe("admin");
    expect(() =>
      setOrganizationMemberRole(database, { ...mutation, actor, userId: "admin", role: "member" }),
    ).toThrow();
  });

  it("provisions a replacement default when a user's only membership is removed", () => {
    const { database, organizationId } = setup();
    expect(authorizeOrganization).toBeDefined();
    const actor = authorizeOrganization(
      database.db,
      { organizationId, userId: "admin" },
      "members-manage",
    );
    removeOrganizationMember(database, { ...mutation, actor, userId: "member" });
    const defaults = database.db
      .select()
      .from(organizationMemberships)
      .where(eq(organizationMemberships.userId, "member"))
      .all();
    expect(defaults).toHaveLength(1);
    expect(defaults[0]).toMatchObject({ role: "owner", isDefault: true });
    expect(defaults[0]?.organizationId).not.toBe(organizationId);
    expect(database.db.select().from(organizations).all()).toHaveLength(3);
    expect(() =>
      setDefaultOrganization(database, { ...mutation, userId: "member", organizationId }),
    ).toThrow();
  });
});
