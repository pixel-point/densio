import { makeOrganizationInvitationLinks } from "../src/organizations/organization-invitation-link.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";

import { makeMagicLinkOpener, makeMagicLinkSealer } from "../src/auth/magic-link-secret.ts";
import { type Database, migrateDatabase, openDatabase } from "../src/database/database.ts";
import { authChallenges, emailOutbox } from "../src/database/schema.ts";
import { claimNextEmail, type OutboxEmail } from "../src/email/email-outbox-repository.ts";
import {
  deliverNextEmail,
  EmailSendError,
  type EmailSender,
} from "../src/email/email-outbox-worker.ts";

const NOW = 1_800_000_000_000;
const OUTBOX_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
const invitationLinks = makeOrganizationInvitationLinks(
  OUTBOX_ENCRYPTION_KEY,
  "https://media.example",
);
const openMagicLink = makeMagicLinkOpener(OUTBOX_ENCRYPTION_KEY);
const sealMagicLink = makeMagicLinkSealer(OUTBOX_ENCRYPTION_KEY);
const databases: Array<Database> = [];
const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

it("leases one due email and recovers an abandoned lease", async () => {
  const database = await createTestDatabase();
  seedEmail(database);

  const first = claimNextEmail(database, { leaseMs: 1_000, now: NOW });

  expect(first).toMatchObject({ attempts: 1, recipient: "agent@example.com" });
  expect(claimNextEmail(database, { leaseMs: 1_000, now: NOW + 999 })).toBeUndefined();
  expect(claimNextEmail(database, { leaseMs: 1_000, now: NOW + 1_000 })).toMatchObject({
    attempts: 2,
  });
});

it("renders and sends a magic link before marking the email sent", async () => {
  const database = await createTestDatabase();
  seedEmail(database);
  const deliveries: Array<Parameters<EmailSender["send"]>[0]> = [];
  const sender: EmailSender = {
    send: (email) => {
      deliveries.push(email);
      return Effect.void;
    },
  };

  const outcome = await Effect.runPromise(
    deliverNextEmail({
      config: workerConfig,
      database,
      now: NOW,
      openMagicLink,
      invitationLinks,
      sender,
    }),
  );

  expect(outcome).toEqual({ kind: "sent" });
  expect(deliveries).toEqual([
    expect.objectContaining({
      from: "Media API <login@example.com>",
      subject: "Confirm your sign-in to Densio",
      to: "agent@example.com",
    }),
  ]);
  expect(deliveries[0]?.html).toContain("https://media.example/v1/auth/confirm?token=secret");
  expect(deliveries[0]?.html).toContain("Access your account");
  expect(deliveries[0]?.html).toContain("<h1");
  expect(deliveries[0]?.text).toContain("If the button above does not work");
  expect(readEmail(database)).toMatchObject({
    payloadJson: null,
    lastError: null,
    sentAt: NOW,
    status: "sent",
  });
});

it.each(["expired", "confirmed"])("does not deliver a %s sign-in request", async (state) => {
  const database = await createTestDatabase();
  seedEmail(database);
  database.db
    .update(authChallenges)
    .set(state === "expired" ? { expiresAt: NOW } : { status: "confirmed" })
    .run();
  const deliveries: Parameters<EmailSender["send"]>[0][] = [];
  const outcome = await Effect.runPromise(
    deliverNextEmail({
      config: workerConfig,
      database,
      now: NOW,
      openMagicLink,
      invitationLinks,
      sender: {
        send: (email) => {
          deliveries.push(email);
          return Effect.void;
        },
      },
    }),
  );
  expect(outcome).toEqual({ kind: "failed" });
  expect(deliveries).toHaveLength(0);
  expect(readEmail(database)).toMatchObject({
    payloadJson: null,
    lastError: "notification-no-longer-valid",
    status: "failed",
  });
});

it("schedules bounded retries without persisting provider error details", async () => {
  const database = await createTestDatabase();
  seedEmail(database);
  const sender: EmailSender = {
    send: () =>
      Effect.fail(new EmailSendError({ providerCode: "provider-unavailable", retryable: true })),
  };

  const outcome = await Effect.runPromise(
    deliverNextEmail({
      config: workerConfig,
      database,
      now: NOW,
      openMagicLink,
      invitationLinks,
      sender,
    }),
  );

  expect(outcome).toEqual({ kind: "retry-scheduled", retryAt: NOW + 1_000 });
  expect(readEmail(database)).toMatchObject({
    lastError: "provider-unavailable",
    nextAttemptAt: NOW + 1_000,
    status: "failed",
  });
  expect(readEmail(database)?.lastError).not.toContain("secret");
  expect(readEmail(database)?.payloadJson).not.toBeNull();
});

it("permanently fails and scrubs a corrupt payload without calling the sender", async () => {
  const database = await createTestDatabase();
  seedEmail(database, "corrupt-envelope");
  const deliveries: Array<Parameters<EmailSender["send"]>[0]> = [];
  const sender: EmailSender = {
    send: (email) => {
      deliveries.push(email);
      return Effect.void;
    },
  };

  const outcome = await Effect.runPromise(
    deliverNextEmail({
      config: workerConfig,
      database,
      now: NOW,
      openMagicLink,
      invitationLinks,
      sender,
    }),
  );

  expect(outcome).toEqual({ kind: "failed" });
  expect(deliveries).toHaveLength(0);
  expect(readEmail(database)).toMatchObject({
    payloadJson: null,
    lastError: "invalid-outbox-secret",
    status: "failed",
  });
});

const workerConfig = {
  from: "Media API <login@example.com>",
  leaseMs: 5_000,
  maxAttempts: 3,
  retryBaseMs: 1_000,
};

const createTestDatabase = async () => {
  const directory = await mkdtemp(join(tmpdir(), "densio-email-outbox-"));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, "database.sqlite"));
  databases.push(database);
  migrateDatabase(database);
  return database;
};

const seedEmail = (database: Database, encryptedConfirmationUrl?: string) => {
  database.db
    .insert(authChallenges)
    .values({
      confirmationTokenHash: "confirmation-hash",
      createdAt: NOW,
      email: "agent@example.com",
      expiresAt: NOW + 60_000,
      id: "challenge-1",
      pollingTokenHash: "polling-hash",
      requestIpHash: "ip-hash",
      status: "pending",
    })
    .run();
  database.db
    .insert(emailOutbox)
    .values({
      resourceKey: "magic-login:challenge-1",
      payloadJson: JSON.stringify({
        kind: "magic-login",
        challengeId: "challenge-1",
        encryptedConfirmationUrl:
          encryptedConfirmationUrl ??
          sealMagicLink("https://media.example/v1/auth/confirm?token=secret", {
            challengeId: "challenge-1",
            emailId: "email-1",
            recipient: "agent@example.com",
          }),
      }),
      createdAt: NOW,
      id: "email-1",
      nextAttemptAt: NOW,
      recipient: "agent@example.com",
      status: "pending",
    })
    .run();
};

const readEmail = (database: Database): OutboxEmail | undefined =>
  database.db.select().from(emailOutbox).where(eq(emailOutbox.id, "email-1")).get();
