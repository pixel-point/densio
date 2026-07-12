import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";

import { AuthSessionUnauthorized, RefreshTokenReplay } from "../src/auth/auth-errors.ts";
import { makeAuthService } from "../src/auth/auth-service.ts";
import { makeMagicLinkOpener, makeMagicLinkSealer } from "../src/auth/magic-link-secret.ts";
import {
  createOpaqueToken,
  formatOpaqueToken,
  parseOpaqueToken,
  ParsedOpaqueToken,
  verifyTokenSecret,
} from "../src/auth/opaque-token.ts";
import { type Database, migrateDatabase, openDatabase } from "../src/database/database.ts";
import { emailOutbox, sessionRefreshTokens, sessions } from "../src/database/schema.ts";

const NOW = 1_800_000_000_000;
const OUTBOX_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
const openMagicLink = makeMagicLinkOpener(OUTBOX_ENCRYPTION_KEY);
const sealMagicLink = makeMagicLinkSealer(OUTBOX_ENCRYPTION_KEY);
const AUTH_CONFIG = {
  accessTokenTtlMs: 15 * 60_000,
  challengeTtlMs: 10 * 60_000,
  maxChallengesPerEmail: 5,
  maxChallengesPerIp: 5,
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

it("looks up a valid access token and rejects invalid or expired tokens", async () => {
  const { authenticated, service } = await completeLogin();

  await expect(
    Effect.runPromise(
      service.lookupAccess({
        accessToken: authenticated.accessToken,
        now: NOW + 4,
      }),
    ),
  ).resolves.toMatchObject({ email: "agent@example.com" });

  const access = await Effect.runPromise(parseOpaqueToken(authenticated.accessToken));
  const wrongAccess = formatOpaqueToken(
    new ParsedOpaqueToken(access.publicId, createOpaqueToken().secret),
  );
  const invalid = await Effect.runPromise(
    Effect.flip(service.lookupAccess({ accessToken: wrongAccess, now: NOW + 4 })),
  );
  const expired = await Effect.runPromise(
    Effect.flip(
      service.lookupAccess({
        accessToken: authenticated.accessToken,
        now: authenticated.accessExpiresAt,
      }),
    ),
  );

  expect(invalid).toEqual(new AuthSessionUnauthorized({ reason: "invalid" }));
  expect(expired).toEqual(new AuthSessionUnauthorized({ reason: "expired" }));
});

it("rotates refresh and access tokens without extending the family lifetime", async () => {
  const { authenticated, database, service } = await completeLogin();
  const rotated = await Effect.runPromise(
    service.refresh({
      config: AUTH_CONFIG,
      now: NOW + 10,
      refreshToken: authenticated.refreshToken,
    }),
  );
  const refreshRows = database.db.select().from(sessionRefreshTokens).all();
  const currentSession = database.db.select().from(sessions).get();
  const access = await Effect.runPromise(parseOpaqueToken(rotated.accessToken));
  const refresh = await Effect.runPromise(parseOpaqueToken(rotated.refreshToken));

  expect(rotated.accessToken).not.toBe(authenticated.accessToken);
  expect(rotated.refreshToken).not.toBe(authenticated.refreshToken);
  expect(rotated.refreshExpiresAt).toBe(authenticated.refreshExpiresAt);
  expect(refreshRows.map(({ status }) => status).toSorted()).toEqual(["active", "rotated"]);
  expect(verifyTokenSecret(access.secret, currentSession?.accessTokenHash ?? "")).toBe(true);
  expect(
    verifyTokenSecret(
      refresh.secret,
      refreshRows.find(({ status }) => status === "active")?.tokenHash ?? "",
    ),
  ).toBe(true);
  await expect(
    Effect.runPromise(service.lookupAccess({ accessToken: rotated.accessToken, now: NOW + 11 })),
  ).resolves.toMatchObject({ email: "agent@example.com" });
  await expect(
    Effect.runPromise(
      Effect.flip(
        service.lookupAccess({
          accessToken: authenticated.accessToken,
          now: NOW + 11,
        }),
      ),
    ),
  ).resolves.toEqual(new AuthSessionUnauthorized({ reason: "invalid" }));
});

it("detects refresh replay and revokes the entire token family", async () => {
  const { authenticated, database, service } = await completeLogin();
  const rotated = await Effect.runPromise(
    service.refresh({
      config: AUTH_CONFIG,
      now: NOW + 10,
      refreshToken: authenticated.refreshToken,
    }),
  );

  const replay = await Effect.runPromise(
    Effect.flip(
      service.refresh({
        config: AUTH_CONFIG,
        now: NOW + 11,
        refreshToken: authenticated.refreshToken,
      }),
    ),
  );

  expect(replay).toBeInstanceOf(RefreshTokenReplay);
  expect(database.db.select().from(sessions).get()?.revokedAt).toBe(NOW + 11);
  expect(
    database.db
      .select()
      .from(sessionRefreshTokens)
      .all()
      .every(({ status }) => status === "revoked"),
  ).toBe(true);
  await expect(
    Effect.runPromise(
      Effect.flip(service.lookupAccess({ accessToken: rotated.accessToken, now: NOW + 12 })),
    ),
  ).resolves.toEqual(new AuthSessionUnauthorized({ reason: "revoked" }));
  await expect(
    Effect.runPromise(
      Effect.flip(
        service.refresh({
          config: AUTH_CONFIG,
          now: NOW + 12,
          refreshToken: rotated.refreshToken,
        }),
      ),
    ),
  ).resolves.toEqual(new AuthSessionUnauthorized({ reason: "revoked" }));
});

it("logs out the current auth token family idempotently", async () => {
  const { authenticated, service } = await completeLogin();

  await expect(
    Effect.runPromise(service.logout({ accessToken: authenticated.accessToken, now: NOW + 10 })),
  ).resolves.toBeUndefined();
  await expect(
    Effect.runPromise(service.logout({ accessToken: authenticated.accessToken, now: NOW + 11 })),
  ).resolves.toBeUndefined();
  await expect(
    Effect.runPromise(
      Effect.flip(
        service.lookupAccess({
          accessToken: authenticated.accessToken,
          now: NOW + 12,
        }),
      ),
    ),
  ).resolves.toEqual(new AuthSessionUnauthorized({ reason: "revoked" }));
  await expect(
    Effect.runPromise(
      Effect.flip(
        service.refresh({
          config: AUTH_CONFIG,
          now: NOW + 12,
          refreshToken: authenticated.refreshToken,
        }),
      ),
    ),
  ).resolves.toEqual(new AuthSessionUnauthorized({ reason: "revoked" }));
});

const completeLogin = async () => {
  const database = await createTestDatabase();
  const service = makeAuthService(database, sealMagicLink);
  const login = await Effect.runPromise(
    service.requestLogin({
      config: AUTH_CONFIG,
      email: "agent@example.com",
      now: NOW,
      requestIpHash: "ip-hash-a",
    }),
  );
  const outbox = database.db.select().from(emailOutbox).get();
  if (outbox === undefined) throw new Error("Missing confirmation URL");
  const confirmationUrl = openMagicLink(outbox.encryptedConfirmationUrl ?? "", {
    challengeId: outbox.challengeId,
    emailId: outbox.id,
    recipient: outbox.recipient,
  });
  const confirmationToken = new URL(confirmationUrl).searchParams.get("token");
  if (confirmationToken === null) throw new Error("Missing confirmation token");
  await Effect.runPromise(service.confirm({ confirmationToken, now: NOW + 1 }));
  const authenticated = await Effect.runPromise(
    service.poll({
      config: AUTH_CONFIG,
      now: NOW + 2,
      pollingToken: login.pollingToken,
    }),
  );
  if (authenticated.status !== "authenticated") {
    throw new Error("Expected authenticated result");
  }
  return { authenticated, database, service };
};

const createTestDatabase = async () => {
  const directory = await mkdtemp(join(tmpdir(), "ffmpeg-api-auth-session-"));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, "database.sqlite"));
  databases.push(database);
  migrateDatabase(database);
  return database;
};
