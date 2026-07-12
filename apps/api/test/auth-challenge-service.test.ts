import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";

import {
  AuthChallengeUnavailable,
  AuthRateLimitExceeded,
  AuthStorageError,
} from "../src/auth/auth-errors.ts";
import { makeAuthService } from "../src/auth/auth-service.ts";
import { makeMagicLinkOpener, makeMagicLinkSealer } from "../src/auth/magic-link-secret.ts";
import { parseOpaqueToken, verifyTokenSecret } from "../src/auth/opaque-token.ts";
import { type Database, migrateDatabase, openDatabase } from "../src/database/database.ts";
import {
  authChallenges,
  emailOutbox,
  sessionRefreshTokens,
  sessions,
  users,
} from "../src/database/schema.ts";

const NOW = 1_800_000_000_000;
const OUTBOX_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
const openMagicLink = makeMagicLinkOpener(OUTBOX_ENCRYPTION_KEY);
const sealMagicLink = makeMagicLinkSealer(OUTBOX_ENCRYPTION_KEY);
const AUTH_CONFIG = {
  accessTokenTtlMs: 15 * 60_000,
  challengeTtlMs: 10 * 60_000,
  maxChallengesPerEmail: 2,
  maxChallengesPerIp: 2,
  publicBaseUrl: "https://media.example",
  rateLimitWindowMs: 60_000,
  refreshTokenTtlMs: 30 * 24 * 60 * 60_000,
};

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

it("atomically creates a normalized auth challenge and pending email", async () => {
  const database = await createTestDatabase();
  const service = makeAuthService(database, sealMagicLink);
  const created = await Effect.runPromise(
    service.requestLogin({
      config: AUTH_CONFIG,
      email: "  Agent@Example.COM ",
      now: NOW,
      requestIpHash: "ip-hash-a",
    }),
  );
  const challenge = database.db.select().from(authChallenges).get();
  const outbox = database.db.select().from(emailOutbox).get();
  const pollingToken = await Effect.runPromise(parseOpaqueToken(created.pollingToken));
  const confirmationToken = await Effect.runPromise(
    parseOpaqueToken(readConfirmationToken(outbox)),
  );

  expect(challenge).toMatchObject({
    email: "agent@example.com",
    expiresAt: NOW + AUTH_CONFIG.challengeTtlMs,
    requestIpHash: "ip-hash-a",
    status: "pending",
  });
  expect(outbox).toMatchObject({
    challengeId: challenge?.id,
    nextAttemptAt: NOW,
    recipient: "agent@example.com",
    status: "pending",
  });
  expect(pollingToken.publicId).toBe(challenge?.id);
  expect(confirmationToken.publicId).toBe(challenge?.id);
  expect(verifyTokenSecret(pollingToken.secret, challenge?.pollingTokenHash ?? "")).toBe(true);
  expect(verifyTokenSecret(confirmationToken.secret, challenge?.confirmationTokenHash ?? "")).toBe(
    true,
  );
  expect(JSON.stringify(challenge)).not.toContain(pollingToken.secret);
  expect(JSON.stringify(challenge)).not.toContain(confirmationToken.secret);
  expect(outbox?.encryptedConfirmationUrl).not.toContain(confirmationToken.secret);
  expect(outbox?.encryptedConfirmationUrl).not.toContain("https://");
});

it("rolls back the auth challenge when its outbox insert fails", async () => {
  const database = await createTestDatabase();
  const service = makeAuthService(database, sealMagicLink);
  database.sqlite.exec(`
      create trigger reject_auth_email
      before insert on email_outbox
      begin
        select raise(abort, 'outbox unavailable');
      end
    `);

  const error = await Effect.runPromise(
    Effect.flip(
      service.requestLogin({
        config: AUTH_CONFIG,
        email: "agent@example.com",
        now: NOW,
        requestIpHash: "ip-hash-a",
      }),
    ),
  );

  expect(error).toBeInstanceOf(AuthStorageError);
  expect(database.db.select().from(authChallenges).all()).toHaveLength(0);
  expect(database.db.select().from(emailOutbox).all()).toHaveLength(0);
});

it("rate limits auth requests by normalized email and request IP", async () => {
  const emailDatabase = await createTestDatabase();
  const emailService = makeAuthService(emailDatabase, sealMagicLink);
  await requestLogin(emailService, "AGENT@example.com", "ip-a", NOW);
  await requestLogin(emailService, "agent@example.com", "ip-b", NOW + 10);

  const emailError = await Effect.runPromise(
    Effect.flip(
      emailService.requestLogin({
        config: AUTH_CONFIG,
        email: "agent@example.com",
        now: NOW + 20,
        requestIpHash: "ip-c",
      }),
    ),
  );

  expect(emailError).toEqual(
    new AuthRateLimitExceeded({ retryAt: NOW + AUTH_CONFIG.rateLimitWindowMs }),
  );
  expect(emailDatabase.db.select().from(authChallenges).all()).toHaveLength(2);

  const ipDatabase = await createTestDatabase();
  const ipService = makeAuthService(ipDatabase, sealMagicLink);
  await requestLogin(ipService, "one@example.com", "shared-ip", NOW);
  await requestLogin(ipService, "two@example.com", "shared-ip", NOW + 10);

  const ipError = await Effect.runPromise(
    Effect.flip(
      ipService.requestLogin({
        config: AUTH_CONFIG,
        email: "three@example.com",
        now: NOW + 20,
        requestIpHash: "shared-ip",
      }),
    ),
  );

  expect(ipError).toEqual(
    new AuthRateLimitExceeded({ retryAt: NOW + AUTH_CONFIG.rateLimitWindowMs }),
  );
  expect(ipDatabase.db.select().from(authChallenges).all()).toHaveLength(2);
});

it("confirms an auth challenge exactly once and expires stale challenges", async () => {
  const database = await createTestDatabase();
  const service = makeAuthService(database, sealMagicLink);
  await requestLogin(service, "agent@example.com", "ip-a", NOW);
  const confirmationToken = readConfirmationToken(database.db.select().from(emailOutbox).get());

  await expect(
    Effect.runPromise(service.confirm({ confirmationToken, now: NOW + 1 })),
  ).resolves.toEqual({ status: "confirmed" });
  const secondConfirmation = await Effect.runPromise(
    Effect.flip(service.confirm({ confirmationToken, now: NOW + 2 })),
  );
  expect(secondConfirmation).toEqual(new AuthChallengeUnavailable({ reason: "already-used" }));

  await requestLogin(service, "other@example.com", "ip-b", NOW + 3);
  const stalePollingToken = database.db
    .select()
    .from(authChallenges)
    .all()
    .find(({ email }) => email === "other@example.com");
  const createdRows = database.db
    .select()
    .from(emailOutbox)
    .all()
    .find(({ challengeId }) => challengeId === stalePollingToken?.id);
  const staleConfirmationToken = readConfirmationToken(createdRows);
  const expired = await Effect.runPromise(
    Effect.flip(
      service.confirm({
        confirmationToken: staleConfirmationToken,
        now: NOW + 3 + AUTH_CONFIG.challengeTtlMs,
      }),
    ),
  );

  expect(expired).toEqual(new AuthChallengeUnavailable({ reason: "expired" }));
  expect(
    database.db
      .select()
      .from(authChallenges)
      .all()
      .find(({ id }) => id === stalePollingToken?.id)?.status,
  ).toBe("expired");
});

it("polls pending before confirmation and issues one auth token pair", async () => {
  const database = await createTestDatabase();
  const service = makeAuthService(database, sealMagicLink);
  const login = await requestLogin(service, "agent@example.com", "ip-a", NOW);

  await expect(
    Effect.runPromise(
      service.poll({
        config: AUTH_CONFIG,
        now: NOW + 1,
        pollingToken: login.pollingToken,
      }),
    ),
  ).resolves.toEqual({
    expiresAt: NOW + AUTH_CONFIG.challengeTtlMs,
    status: "pending",
  });

  const confirmationToken = readConfirmationToken(database.db.select().from(emailOutbox).get());
  await Effect.runPromise(service.confirm({ confirmationToken, now: NOW + 2 }));
  const authenticated = await Effect.runPromise(
    service.poll({
      config: AUTH_CONFIG,
      now: NOW + 3,
      pollingToken: login.pollingToken,
    }),
  );

  expect(authenticated).toMatchObject({
    accessExpiresAt: NOW + 3 + AUTH_CONFIG.accessTokenTtlMs,
    refreshExpiresAt: NOW + 3 + AUTH_CONFIG.refreshTokenTtlMs,
    status: "authenticated",
  });
  expect(database.db.select().from(users).all()).toHaveLength(1);
  expect(database.db.select().from(sessions).all()).toHaveLength(1);
  expect(database.db.select().from(sessionRefreshTokens).all()).toHaveLength(1);
  const consumed = await Effect.runPromise(
    Effect.flip(
      service.poll({
        config: AUTH_CONFIG,
        now: NOW + 4,
        pollingToken: login.pollingToken,
      }),
    ),
  );
  expect(consumed).toEqual(new AuthChallengeUnavailable({ reason: "already-used" }));
});

const createTestDatabase = async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffmpeg-api-auth-challenge-"));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, "database.sqlite"));
  databases.push(database);
  migrateDatabase(database);
  return database;
};

const requestLogin = (
  service: ReturnType<typeof makeAuthService>,
  email: string,
  requestIpHash: string,
  now: number,
) =>
  Effect.runPromise(
    service.requestLogin({
      config: AUTH_CONFIG,
      email,
      now,
      requestIpHash,
    }),
  );

const readConfirmationToken = (email: typeof emailOutbox.$inferSelect | undefined) => {
  if (email === undefined) throw new Error("Missing confirmation URL");
  const confirmationUrl = openMagicLink(email.encryptedConfirmationUrl ?? "", {
    challengeId: email.challengeId,
    emailId: email.id,
    recipient: email.recipient,
  });
  const token = new URL(confirmationUrl).searchParams.get("token");
  if (token === null) throw new Error("Missing confirmation token");
  return token;
};
