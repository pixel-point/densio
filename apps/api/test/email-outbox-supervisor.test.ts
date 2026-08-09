import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";

import { createLoginChallenge } from "../src/auth/auth-repository.ts";
import { makeMagicLinkOpener, makeMagicLinkSealer } from "../src/auth/magic-link-secret.ts";
import { type Database, migrateDatabase, openDatabase } from "../src/database/database.ts";
import { emailOutbox } from "../src/database/schema.ts";
import { type EmailSender } from "../src/email/email-outbox-worker.ts";
import { startEmailOutboxSupervisor } from "../src/email/email-outbox-supervisor.ts";

const NOW = Date.now();
const OUTBOX_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
const databases: Array<Database> = [];
const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

it("drains due email and stops without waiting for the next poll", async () => {
  const database = await createTestDatabase();
  seedLogin(database);
  const delivered: Array<string> = [];
  const sender: EmailSender = {
    send: (email) => Effect.sync(() => delivered.push(email.to)),
  };

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const supervisor = yield* startEmailOutboxSupervisor(
          database,
          sender,
          makeMagicLinkOpener(OUTBOX_ENCRYPTION_KEY),
          {
            from: "Media API <login@example.com>",
            leaseMs: 1_000,
            maxAttempts: 3,
            pollIntervalMs: 60_000,
            retryBaseMs: 1_000,
          },
        );
        yield* waitUntil(() => database.db.select().from(emailOutbox).get()?.status === "sent");
        yield* supervisor.stop();
      }),
    ),
  );

  expect(delivered).toEqual(["agent@example.com"]);
});

const createTestDatabase = async () => {
  const directory = await mkdtemp(join(tmpdir(), "densio-email-supervisor-"));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, "database.sqlite"));
  databases.push(database);
  migrateDatabase(database);
  return database;
};

const seedLogin = (database: Database) => {
  createLoginChallenge(database, {
    config: {
      accessTokenTtlMs: 60_000,
      challengeTtlMs: 60_000,
      maxChallengesPerEmail: 2,
      maxChallengesPerIp: 2,
      publicBaseUrl: "https://media.example",
      rateLimitWindowMs: 60_000,
      refreshTokenTtlMs: 60_000,
    },
    email: "agent@example.com",
    now: NOW,
    requestIpHash: "ip-hash",
    sealMagicLink: makeMagicLinkSealer(OUTBOX_ENCRYPTION_KEY),
  });
};

const waitUntil = (predicate: () => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return;
      yield* Effect.sleep(5);
    }
    return yield* Effect.die("Timed out waiting for email delivery");
  });
