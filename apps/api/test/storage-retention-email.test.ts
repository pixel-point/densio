import { makeOrganizationInvitationLinks } from "../src/organizations/organization-invitation-link.ts";
import { afterEach, expect, it } from "vitest";
import { Effect } from "effect";
import { eq } from "drizzle-orm";
import { organizationFixture, organizationNow } from "./organization-test-support.ts";
import { emailOutbox, organizations } from "../src/database/schema.ts";
import { storageSettings } from "../src/database/video-storage-schema.ts";
import { deliverNextEmail, type EmailSender } from "../src/email/email-outbox-worker.ts";
import { makeMagicLinkOpener } from "../src/auth/magic-link-secret.ts";

const fixtures: ReturnType<typeof organizationFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach(({ database }) => database.close()));

const setup = (deadline = organizationNow + 86_400_000) => {
  const fixture = organizationFixture();
  fixtures.push(fixture);
  const { database, organizationId } = fixture;
  database.db
    .insert(storageSettings)
    .values({
      organizationId,
      policyRevision: 1,
      graceDeadline: deadline,
      updatedAt: organizationNow,
    })
    .onConflictDoUpdate({
      target: storageSettings.organizationId,
      set: { policyRevision: 1, graceDeadline: deadline },
    })
    .run();
  database.db
    .insert(emailOutbox)
    .values({
      id: "retention-email",
      resourceKey: "retention-example",
      recipient: "owner@example.test",
      payloadJson: JSON.stringify({
        kind: "storage-retention",
        organizationId,
        revision: 1,
        deadline,
        phase: "initial",
      }),
      createdAt: organizationNow,
      nextAttemptAt: organizationNow,
      status: "pending",
    })
    .run();
  const deliveries: Parameters<EmailSender["send"]>[0][] = [];
  const deliver = () =>
    Effect.runPromise(
      deliverNextEmail({
        database,
        now: organizationNow,
        config: {
          from: "Densio <test@example.test>",
          leaseMs: 5_000,
          maxAttempts: 3,
          retryBaseMs: 1_000,
        },
        openMagicLink: makeMagicLinkOpener("0123456789abcdef".repeat(4)),
        invitationLinks: makeOrganizationInvitationLinks(
          "0123456789abcdef".repeat(4),
          "https://api.example.test",
        ),
        sender: {
          send: (email) => {
            deliveries.push(email);
            return Effect.void;
          },
        },
      }),
    );
  const readEmail = () =>
    database.db.select().from(emailOutbox).where(eq(emailOutbox.id, "retention-email")).get();
  return { ...fixture, deliveries, deliver, readEmail };
};

it("delivers a styled retention notice with a readable deadline and scrubs the outbox", async () => {
  const fixture = setup();
  expect(await fixture.deliver()).toEqual({ kind: "sent" });
  expect(fixture.deliveries[0]).toMatchObject({
    to: "owner@example.test",
    subject: "Action required: your Densio storage is over its limit",
    idempotencyKey: "storage-retention-email-retention-email",
  });
  expect(fixture.deliveries[0]?.html).toContain("<h1");
  expect(fixture.deliveries[0]?.text).toContain("September 5, 2026");
  expect(fixture.deliveries[0]?.text).toContain("Densio will permanently delete videos it hosts");
  expect(fixture.deliveries[0]?.text).not.toContain("densio --org");
  expect(fixture.readEmail()).toMatchObject({
    status: "sent",
    payloadJson: null,
    sentAt: organizationNow,
  });
});

it.each(["revision", "deadline", "recipient", "inactive"])(
  "suppresses a retention notice after its %s changes",
  async (change) => {
    const fixture = setup();
    const { database, organizationId } = fixture;
    if (change === "revision" || change === "deadline") {
      database.db
        .update(storageSettings)
        .set(change === "revision" ? { policyRevision: 2 } : { graceDeadline: null })
        .where(eq(storageSettings.organizationId, organizationId))
        .run();
    }
    if (change === "recipient" || change === "inactive") {
      database.db
        .update(organizations)
        .set(change === "recipient" ? { billingEmail: "other@example.test" } : { state: "deleted" })
        .where(eq(organizations.id, organizationId))
        .run();
    }
    expect(await fixture.deliver()).toEqual({ kind: "failed" });
    expect(fixture.deliveries).toHaveLength(0);
    expect(fixture.readEmail()).toMatchObject({
      status: "failed",
      payloadJson: null,
      lastError: "notification-no-longer-valid",
    });
  },
);

it("records a sanitized rendering failure without sending an incomplete email", async () => {
  const fixture = setup(8_640_000_000_000_001);
  expect(await fixture.deliver()).toEqual({ kind: "failed" });
  expect(fixture.deliveries).toHaveLength(0);
  expect(fixture.readEmail()).toMatchObject({
    status: "failed",
    payloadJson: null,
    lastError: "email-render-failed",
  });
});
