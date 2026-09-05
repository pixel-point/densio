import { Effect } from "effect";
import { and, eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { organizationFixture, organizationNow } from "./organization-test-support.ts";
import { authorizeOrganization } from "../src/organizations/organization-access.ts";
import { makeOrganizationInvitationLinks } from "../src/organizations/organization-invitation-link.ts";
import { makeOrganizationInvitationLinkService } from "../src/organizations/organization-invitation-link-service.ts";
import { createOrganizationInvitationLinkRoutes } from "../src/routes/organization-invitation-links.ts";
import {
  createOrganizationInvitation,
  revokeOrganizationInvitation,
} from "../src/database/organization-invitation-repository.ts";
import {
  removeOrganizationMember,
  setOrganizationMemberRole,
} from "../src/database/organization-repository.ts";
import {
  emailOutbox,
  organizations,
  organizationInvitations,
  organizationMemberships,
  organizationAuditEvents,
  sessions,
  users,
} from "../src/database/schema.ts";
import { deliverNextEmail } from "../src/email/email-outbox-worker.ts";
import { makeMagicLinkOpener } from "../src/auth/magic-link-secret.ts";

const key = "0123456789abcdef".repeat(4);
const fixtures: ReturnType<typeof organizationFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach(({ database }) => database.close()));

const setup = (email = "outsider@example.test", inviter = "owner") => {
  const fixture = organizationFixture();
  fixtures.push(fixture);
  const clock = { now: organizationNow + 1 };
  const invitationLinks = makeOrganizationInvitationLinks(key, "https://api.example.test");
  const actor = authorizeOrganization(
    fixture.database.db,
    { userId: inviter, organizationId: fixture.organizationId },
    "invitations-read",
  );
  const invitation = createOrganizationInvitation(fixture.database, {
    actor,
    email,
    role: "member",
    maxInvitationsPerHour: 30,
    now: clock.now,
    correlationId: "link-test",
  });
  const app = createOrganizationInvitationLinkRoutes({
    invitationLinkService: makeOrganizationInvitationLinkService(fixture.database, invitationLinks),
    now: () => clock.now,
    createCorrelationId: () => "link-test",
  });
  const url = invitationLinks.url(invitation);
  const token = new URL(url).searchParams.get("token") ?? "";
  const accept = (value = token, extra = {}) =>
    app.request("/v1/organization-invitations/confirm", {
      method: "POST",
      body: new URLSearchParams({ token: value, ...extra }),
    });
  const memberships = () =>
    fixture.database.db
      .select()
      .from(organizationMemberships)
      .where(eq(organizationMemberships.organizationId, fixture.organizationId))
      .all();
  return {
    ...fixture,
    app,
    clock,
    invitation,
    invitationLinks,
    actor,
    url,
    token,
    accept,
    memberships,
  };
};

it("delivers a browser link whose GET is read-only and whose POST joins the addressed email", async () => {
  const f = setup();
  const deliveries: string[] = [];
  expect(f.database.db.select().from(emailOutbox).get()?.payloadJson).not.toContain(f.token);
  await Effect.runPromise(
    deliverNextEmail({
      database: f.database,
      now: f.clock.now,
      invitationLinks: f.invitationLinks,
      openMagicLink: makeMagicLinkOpener(key),
      config: {
        from: "Densio <test@example.test>",
        leaseMs: 1000,
        maxAttempts: 3,
        retryBaseMs: 1000,
      },
      sender: {
        send: (email) => {
          deliveries.push(email.text);
          return Effect.void;
        },
      },
    }),
  );
  expect(deliveries[0]).toContain(f.url);
  expect(deliveries[0]).not.toContain("npx");
  const page = await f.app.request(f.url);
  expect(page.status).toBe(200);
  expect(page.headers.get("cache-control")).toBe("no-store");
  expect(page.headers.get("referrer-policy")).toBe("no-referrer");
  expect(page.headers.get("content-security-policy")).toContain("form-action 'self'");
  const html = await page.text();
  expect(html).toContain('method="post"');
  expect(html).toContain("Accept invitation");
  expect(html).toContain("outsider@example.test");
  expect(f.memberships()).toHaveLength(3);
  expect((await f.app.request(f.url, { method: "HEAD" })).status).toBe(200);
  expect(f.memberships()).toHaveLength(3);
  const result = await f.accept();
  expect(result.status).toBe(200);
  expect(await result.text()).toContain("Invitation accepted");
  expect(f.memberships()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ userId: "outsider", role: "member", isDefault: false }),
    ]),
  );
  expect(f.database.db.select().from(sessions).all()).toHaveLength(0);
  expect(
    f.database.db
      .select()
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.userId, "outsider"),
          eq(organizationMemberships.isDefault, true),
        ),
      )
      .get()?.organizationId,
  ).toBe(f.outside.organization.id);
  expect((await f.accept()).status).toBe(200);
  expect(f.memberships()).toHaveLength(4);
  expect(
    f.database.db
      .select()
      .from(organizationAuditEvents)
      .where(
        and(
          eq(organizationAuditEvents.targetId, f.invitation.id),
          eq(organizationAuditEvents.kind, "invitation-accepted"),
        ),
      )
      .all(),
  ).toHaveLength(1);
});

it("registers a new recipient on acceptance using the normal default-organization policy", async () => {
  const f = setup("new@example.test");
  await f.app.request(f.url);
  expect(
    f.database.db.select().from(users).where(eq(users.email, "new@example.test")).get(),
  ).toBeUndefined();
  expect((await f.accept()).status).toBe(200);
  const user = f.database.db.select().from(users).where(eq(users.email, "new@example.test")).get();
  expect(user).toBeDefined();
  const memberships = f.database.db
    .select()
    .from(organizationMemberships)
    .where(eq(organizationMemberships.userId, user?.id ?? ""))
    .all();
  expect(memberships).toHaveLength(2);
  expect(memberships).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        organizationId: f.organizationId,
        role: "member",
        isDefault: false,
      }),
      expect.objectContaining({ role: "owner", isDefault: true }),
    ]),
  );
});

it("rolls registration and membership back together if acceptance cannot be persisted", async () => {
  const f = setup("new@example.test");
  f.database.sqlite.exec(`
    CREATE TRIGGER fail_invitation_acceptance BEFORE INSERT ON organization_audit_events
    WHEN NEW.kind = 'invitation-accepted'
    BEGIN SELECT RAISE(ABORT, 'forced acceptance failure'); END;
  `);
  const response = await f.accept();
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("forced acceptance failure");
  expect(f.database.db.select().from(users).all()).toHaveLength(4);
  expect(f.database.db.select().from(organizations).all()).toHaveLength(2);
  expect(f.memberships()).toHaveLength(3);
  expect(f.database.db.select().from(organizationInvitations).get()?.state).toBe("pending");
  f.database.sqlite.exec("DROP TRIGGER fail_invitation_acceptance");
  expect((await f.accept()).status).toBe(200);
  expect(f.database.db.select().from(users).all()).toHaveLength(5);
  expect(f.memberships()).toHaveLength(4);
});

it("rejects invalid links without revealing the recipient or creating identities", async () => {
  const f = setup("new@example.test");
  const other = setup("different@example.test");
  const wrongKey = makeOrganizationInvitationLinks("ab".repeat(32), "https://api.example.test");
  const invalid = [
    "",
    f.invitation.id,
    `${f.invitation.id}.${"a".repeat(43)}`,
    `${other.invitation.id}.${f.token.split(".")[1]}`,
    new URL(wrongKey.url(f.invitation)).searchParams.get("token") ?? "",
  ];
  for (const token of invalid) {
    const response = await f.accept(token);
    expect(response.status).toBe(token === "" ? 400 : 404);
    const html = await response.text();
    expect(html).not.toContain("new@example.test");
    expect(html).not.toContain(f.invitation.email);
  }
  expect(f.database.db.select().from(users).all()).toHaveLength(4);
  expect(f.memberships()).toHaveLength(3);
});

it.each(["revoked", "expired", "closed", "demoted"] as const)(
  "rejects %s invitations on both GET and POST",
  async (state) => {
    const f = setup("new@example.test", state === "demoted" ? "admin" : "owner");
    if (state === "revoked")
      revokeOrganizationInvitation(f.database, {
        actor: f.actor,
        invitationId: f.invitation.id,
        now: f.clock.now,
        correlationId: "revoke",
      });
    if (state === "expired") f.clock.now = f.invitation.expiresAt;
    if (state === "closed")
      f.database.db
        .update(organizations)
        .set({ state: "deleting" })
        .where(eq(organizations.id, f.organizationId))
        .run();
    if (state === "demoted")
      setOrganizationMemberRole(f.database, {
        actor: authorizeOrganization(
          f.database.db,
          { userId: "owner", organizationId: f.organizationId },
          "members-manage",
        ),
        userId: "admin",
        role: "member",
        now: f.clock.now,
        correlationId: "demote",
      });
    const expectedStatus = state === "expired" ? 410 : 409;
    expect((await f.app.request(f.url)).status).toBe(expectedStatus);
    expect((await f.accept()).status).toBe(expectedStatus);
    expect(f.database.db.select().from(users).all()).toHaveLength(4);
    expect(f.memberships()).toHaveLength(3);
  },
);

it("cannot use an accepted link to restore a removed membership", async () => {
  const f = setup();
  expect((await f.accept()).status).toBe(200);
  removeOrganizationMember(f.database, {
    actor: f.actor,
    userId: "outsider",
    now: f.clock.now,
    correlationId: "remove",
  });
  expect((await f.accept()).status).toBe(409);
  expect((await f.app.request(f.url)).status).toBe(409);
  expect(f.memberships()).toHaveLength(3);
});

it("binds the signed link to the recipient and granted role", async () => {
  const f = setup();
  f.database.db
    .update(organizationInvitations)
    .set({ email: "member@example.test", role: "admin" })
    .where(eq(organizationInvitations.id, f.invitation.id))
    .run();
  expect((await f.accept()).status).toBe(404);
  expect(f.memberships()).toHaveLength(3);
});

it("escapes organization names and rejects extra identity fields and oversized forms", async () => {
  const f = setup();
  f.database.db
    .update(organizations)
    .set({ name: '<script>alert("x")</script>' })
    .where(eq(organizations.id, f.organizationId))
    .run();
  const page = await f.app.request(f.url);
  const html = await page.text();
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect((await f.accept(f.token, { email: "owner@example.test" })).status).toBe(400);
  expect((await f.accept("a".repeat(10_000))).status).toBe(413);
  expect(f.memberships()).toHaveLength(3);
});
