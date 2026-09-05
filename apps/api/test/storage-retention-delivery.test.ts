import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { makeMagicLinkOpener } from "../src/auth/magic-link-secret.ts";
import { emailOutbox, stripeSubscriptions } from "../src/database/schema.ts";
import { deliverNextEmail, type EmailSender } from "../src/email/email-outbox-worker.ts";
import { makeOrganizationInvitationLinks } from "../src/organizations/organization-invitation-link.ts";
import { maintainStoragePolicy } from "../src/storage/managed/storage-retention.ts";
import { cleanupJobFixtures } from "./job-fixture.ts";
import { videoStorageFixture } from "./video-storage-fixture.ts";

afterEach(cleanupJobFixtures);

const setup = async () => {
  const fixture = await videoStorageFixture();
  await Effect.runPromise(fixture.worker.maintain());
  fixture.database.db.update(stripeSubscriptions).set({ status: "canceled" }).run();
  const deliveries: Parameters<EmailSender["send"]>[0][] = [];
  const key = "0123456789abcdef".repeat(4);
  const maintain = () => Effect.runPromise(maintainStoragePolicy(fixture.database, fixture.config));
  const deliver = () =>
    Effect.runPromise(
      deliverNextEmail({
        database: fixture.database,
        now: fixture.config.now(),
        openMagicLink: makeMagicLinkOpener(key),
        invitationLinks: makeOrganizationInvitationLinks(key, fixture.config.publicBaseUrl),
        config: {
          from: "Densio <notify@example.test>",
          leaseMs: 1000,
          maxAttempts: 3,
          retryBaseMs: 1000,
        },
        sender: {
          send: (email) =>
            Effect.sync(() => {
              deliveries.push(email);
            }),
        },
      }),
    );
  const outbox = () => fixture.database.db.select().from(emailOutbox).all();
  return { ...fixture, deliveries, maintain, deliver, outbox };
};

it("delivers the initial, seven-day, and one-day notices from the real storage policy", async () => {
  const fixture = await setup();
  await fixture.maintain();
  expect(await fixture.deliver()).toEqual({ kind: "sent" });
  await fixture.maintain();
  expect(await fixture.deliver()).toEqual({ kind: "idle" });

  fixture.advance(23 * 86_400_000);
  await fixture.maintain();
  expect(await fixture.deliver()).toEqual({ kind: "sent" });
  fixture.advance(6 * 86_400_000);
  await fixture.maintain();
  expect(await fixture.deliver()).toEqual({ kind: "sent" });
  await fixture.maintain();
  expect(await fixture.deliver()).toEqual({ kind: "idle" });

  expect(fixture.deliveries).toHaveLength(3);
  fixture.deliveries.forEach((email) => {
    expect(email.to).toBe("user-one@example.test");
    expect(email.subject).toBe("Action required: your Densio storage is over its limit");
    expect(email.html).toContain("Your video storage is over its limit");
    expect(email.text).toContain("org-one is using more video storage");
    expect(email.text).toContain("January 31, 1970");
    expect(email.text).toContain("Densio will permanently delete videos it hosts");
    expect(email.text).not.toContain("densio --org");
  });
  expect(new Set(fixture.deliveries.map((email) => email.idempotencyKey)).size).toBe(3);
  expect(fixture.outbox()).toHaveLength(3);
  fixture
    .outbox()
    .forEach((email) => expect(email).toMatchObject({ status: "sent", payloadJson: null }));
});

it("suppresses a queued notice when the restored plan covers the stored videos", async () => {
  const fixture = await setup();
  await fixture.maintain();
  expect(fixture.outbox()).toHaveLength(1);
  fixture.database.db.update(stripeSubscriptions).set({ status: "active" }).run();
  await fixture.maintain();
  expect(await fixture.deliver()).toEqual({ kind: "failed" });
  expect(fixture.deliveries).toHaveLength(0);
  expect(fixture.outbox()[0]).toMatchObject({
    status: "failed",
    lastError: "notification-no-longer-valid",
    payloadJson: null,
  });
});
