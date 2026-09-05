import { makeOrganizationInvitationLinks } from "../src/organizations/organization-invitation-link.ts";
import { Effect } from "effect";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { organizationFixture, organizationNow } from "./organization-test-support.ts";
import {
  organizationInvitations,
  organizationAuditEvents,
  organizationMemberships,
  emailOutbox,
} from "../src/database/schema.ts";
import { authorizeOrganization } from "../src/organizations/organization-access.ts";
import {
  removeOrganizationMember,
  setOrganizationMemberRole,
} from "../src/database/organization-repository.ts";
import {
  createOrganizationInvitation,
  acceptOrganizationInvitation,
  revokeOrganizationInvitation,
} from "../src/database/organization-invitation-repository.ts";
import { deliverNextEmail, type EmailSender } from "../src/email/email-outbox-worker.ts";
import { makeMagicLinkOpener } from "../src/auth/magic-link-secret.ts";

const fixtures: ReturnType<typeof organizationFixture>[] = [];
const setup = () => {
  const fixture = organizationFixture();
  fixtures.push(fixture);
  return fixture;
};
afterEach(() => fixtures.splice(0).forEach(({ database }) => database.close()));
const mutation = { now: organizationNow + 1, correlationId: "invite-test" };
const inviteInput = (fixture: ReturnType<typeof setup>, userId = "owner") => ({
  ...mutation,
  actor: authorizeOrganization(
    fixture.database.db,
    { organizationId: fixture.organizationId, userId },
    "invitations-read",
  ),
  email: "OUTSIDER@example.test",
  role: "member" as const,
  maxInvitationsPerHour: 30,
});

describe("organization invitations", () => {
  it("addresses verified email and deduplicates equivalent pending invitations", () => {
    expect(createOrganizationInvitation).toBeDefined();
    const fixture = setup();
    const invite = createOrganizationInvitation(fixture.database, inviteInput(fixture));
    expect(invite.email).toBe("outsider@example.test");
    expect(
      createOrganizationInvitation(fixture.database, {
        ...inviteInput(fixture),
        now: organizationNow + 2,
      }),
    ).toEqual(invite);
    expect(fixture.database.db.select().from(emailOutbox).all()).toHaveLength(1);
    expect(() =>
      createOrganizationInvitation(fixture.database, { ...inviteInput(fixture), role: "admin" }),
    ).toThrowError(expect.objectContaining({ code: "ORGANIZATION_INVITATION_CONFLICT" }));
    expect(() =>
      acceptOrganizationInvitation(fixture.database, {
        ...mutation,
        invitationId: invite.id,
        userId: "member",
      }),
    ).toThrowError(expect.objectContaining({ code: "ORGANIZATION_INVITATION_NOT_FOUND" }));
    const accepted = acceptOrganizationInvitation(fixture.database, {
      ...mutation,
      invitationId: invite.id,
      userId: "outsider",
    });
    expect(accepted.membership).toMatchObject({
      organizationId: fixture.organizationId,
      userId: "outsider",
      isDefault: false,
    });
    expect(
      acceptOrganizationInvitation(fixture.database, {
        ...mutation,
        invitationId: invite.id,
        userId: "outsider",
      }),
    ).toMatchObject({ replayed: true, membership: accepted.membership });
  });

  it("cannot rejoin through an old accepted invitation after removal", () => {
    expect(createOrganizationInvitation).toBeDefined();
    const fixture = setup();
    const input = inviteInput(fixture);
    const invite = createOrganizationInvitation(fixture.database, input);
    acceptOrganizationInvitation(fixture.database, {
      ...mutation,
      invitationId: invite.id,
      userId: "outsider",
    });
    removeOrganizationMember(fixture.database, {
      ...mutation,
      actor: input.actor,
      userId: "outsider",
    });
    expect(() =>
      acceptOrganizationInvitation(fixture.database, {
        ...mutation,
        invitationId: invite.id,
        userId: "outsider",
      }),
    ).toThrowError(expect.objectContaining({ code: "ORGANIZATION_INVITATION_UNAVAILABLE" }));
    expect(
      fixture.database.db
        .select()
        .from(organizationMemberships)
        .where(eq(organizationMemberships.userId, "outsider"))
        .all(),
    ).toHaveLength(1);
  });
});

describe("invitation revocation and delivery", () => {
  it("denies expired, revoked, and unauthorized-admin invitations", () => {
    expect(createOrganizationInvitation).toBeDefined();
    const fixture = setup();
    expect(() =>
      createOrganizationInvitation(fixture.database, {
        ...inviteInput(fixture, "admin"),
        role: "admin",
      }),
    ).toThrowError(expect.objectContaining({ code: "ORGANIZATION_OWNER_REQUIRED" }));
    const invite = createOrganizationInvitation(fixture.database, inviteInput(fixture));
    expect(() =>
      acceptOrganizationInvitation(fixture.database, {
        ...mutation,
        now: invite.expiresAt,
        invitationId: invite.id,
        userId: "outsider",
      }),
    ).toThrowError(expect.objectContaining({ code: "ORGANIZATION_INVITATION_EXPIRED" }));
    revokeOrganizationInvitation(fixture.database, {
      ...mutation,
      actor: inviteInput(fixture).actor,
      invitationId: invite.id,
    });
    expect(() =>
      acceptOrganizationInvitation(fixture.database, {
        ...mutation,
        invitationId: invite.id,
        userId: "outsider",
      }),
    ).toThrow();
  });

  it("revokes an inviter's pending invitations when they lose grant authority", () => {
    expect(createOrganizationInvitation).toBeDefined();
    const fixture = setup();
    const invite = createOrganizationInvitation(fixture.database, inviteInput(fixture, "admin"));
    setOrganizationMemberRole(fixture.database, {
      ...mutation,
      actor: inviteInput(fixture).actor,
      userId: "admin",
      role: "member",
    });
    expect(
      fixture.database.db
        .select()
        .from(organizationInvitations)
        .where(eq(organizationInvitations.id, invite.id))
        .get()?.state,
    ).toBe("revoked");
    expect(
      fixture.database.db
        .select()
        .from(organizationAuditEvents)
        .where(eq(organizationAuditEvents.targetId, invite.id))
        .all(),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "invitation-revoked" })]));
  });

  it("delivers an invitation acceptance link through the existing durable outbox", async () => {
    expect(createOrganizationInvitation).toBeDefined();
    const fixture = setup();
    const invite = createOrganizationInvitation(fixture.database, inviteInput(fixture));
    const deliveries: Parameters<EmailSender["send"]>[0][] = [];
    const outcome = await Effect.runPromise(
      deliverNextEmail({
        database: fixture.database,
        now: organizationNow + 2,
        config: {
          from: "Densio <test@example.test>",
          leaseMs: 1_000,
          maxAttempts: 3,
          retryBaseMs: 1_000,
        },
        openMagicLink: makeMagicLinkOpener("0123456789abcdef".repeat(4)),
        invitationLinks: makeOrganizationInvitationLinks(
          "0123456789abcdef".repeat(4),
          "https://api.example.test",
        ),
        sender: {
          send: (input) => {
            deliveries.push(input);
            return Effect.void;
          },
        },
      }),
    );
    expect(outcome).toEqual({ kind: "sent" });
    expect(deliveries[0]?.text).toContain(
      makeOrganizationInvitationLinks("0123456789abcdef".repeat(4), "https://api.example.test").url(
        invite,
      ),
    );
    expect(deliveries[0]?.text).not.toContain("npx");
    expect(deliveries[0]?.html).toContain("<h1");
    expect(deliveries[0]?.to).toBe("outsider@example.test");
  });
});
