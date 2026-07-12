import { randomUUID } from "node:crypto";

import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";

import type { Database } from "../database/database.ts";
import {
  authChallenges,
  emailOutbox,
  sessionRefreshTokens,
  sessions,
  users,
} from "../database/schema.ts";
import {
  createOpaqueToken,
  formatOpaqueToken,
  hashTokenSecret,
  ParsedOpaqueToken,
  verifyTokenSecret,
} from "./opaque-token.ts";
import type { MagicLinkSealer } from "./magic-link-secret.ts";

export interface AuthConfig {
  readonly accessTokenTtlMs: number;
  readonly challengeTtlMs: number;
  readonly maxChallengesPerEmail: number;
  readonly maxChallengesPerIp: number;
  readonly publicBaseUrl: string;
  readonly rateLimitWindowMs: number;
  readonly refreshTokenTtlMs: number;
}

export interface RequestedLogin {
  readonly challengeId: string;
  readonly expiresAt: number;
  readonly pollingToken: string;
}

export interface AuthenticatedTokens {
  readonly accessExpiresAt: number;
  readonly accessToken: string;
  readonly refreshExpiresAt: number;
  readonly refreshToken: string;
  readonly status: "authenticated";
}

export interface AccessIdentity {
  readonly accessExpiresAt: number;
  readonly email: string;
  readonly sessionId: string;
  readonly userId: string;
}

export type RequestLoginOutcome =
  | { readonly kind: "created"; readonly login: RequestedLogin }
  | { readonly kind: "rate-limited"; readonly retryAt: number };

export type ChallengeOutcome =
  | { readonly kind: "confirmed" }
  | { readonly kind: "invalid" | "expired" | "already-used" };

export type PollOutcome =
  | { readonly expiresAt: number; readonly kind: "pending" }
  | { readonly kind: "authenticated"; readonly tokens: AuthenticatedTokens }
  | { readonly kind: "invalid" | "expired" | "already-used" };

export type SessionOutcome =
  | { readonly kind: "authenticated"; readonly identity: AccessIdentity }
  | { readonly kind: "invalid" | "expired" | "revoked" };

export type RefreshOutcome =
  | { readonly kind: "rotated"; readonly tokens: AuthenticatedTokens }
  | { readonly kind: "replay" }
  | { readonly kind: "invalid" | "expired" | "revoked" };

export type LogoutOutcome = { readonly kind: "logged-out" } | { readonly kind: "invalid" };

type AuthTransaction = Parameters<Parameters<Database["db"]["transaction"]>[0]>[0];

export const createLoginChallenge = (
  database: Database,
  input: {
    readonly config: AuthConfig;
    readonly email: string;
    readonly now: number;
    readonly requestIpHash: string;
    readonly sealMagicLink: MagicLinkSealer;
  },
): RequestLoginOutcome => {
  const confirmationToken = createOpaqueToken();
  const emailId = randomUUID();
  const pollingToken = new ParsedOpaqueToken(
    confirmationToken.publicId,
    createOpaqueToken().secret,
  );
  const confirmationUrl = new URL("/v1/auth/confirm", input.config.publicBaseUrl);
  confirmationUrl.searchParams.set("token", formatOpaqueToken(confirmationToken));

  return database.db.transaction(
    (transaction) => {
      const retryAt = getRateLimitRetryAt(transaction, input);
      if (retryAt !== undefined) return { kind: "rate-limited", retryAt };

      transaction
        .insert(authChallenges)
        .values({
          confirmationTokenHash: hashTokenSecret(confirmationToken.secret),
          createdAt: input.now,
          email: input.email,
          expiresAt: input.now + input.config.challengeTtlMs,
          id: confirmationToken.publicId,
          pollingTokenHash: hashTokenSecret(pollingToken.secret),
          requestIpHash: input.requestIpHash,
          status: "pending",
        })
        .run();
      transaction
        .insert(emailOutbox)
        .values({
          challengeId: confirmationToken.publicId,
          encryptedConfirmationUrl: input.sealMagicLink(confirmationUrl.toString(), {
            challengeId: confirmationToken.publicId,
            emailId,
            recipient: input.email,
          }),
          createdAt: input.now,
          id: emailId,
          nextAttemptAt: input.now,
          recipient: input.email,
          status: "pending",
        })
        .run();

      return {
        kind: "created",
        login: {
          challengeId: confirmationToken.publicId,
          expiresAt: input.now + input.config.challengeTtlMs,
          pollingToken: formatOpaqueToken(pollingToken),
        },
      };
    },
    { behavior: "immediate" },
  );
};

export const confirmLoginChallenge = (
  { db }: Database,
  token: ParsedOpaqueToken,
  now: number,
): ChallengeOutcome =>
  db.transaction(
    (transaction) => {
      const challenge = transaction
        .select()
        .from(authChallenges)
        .where(eq(authChallenges.id, token.publicId))
        .get();
      if (
        challenge === undefined ||
        !verifyTokenSecret(token.secret, challenge.confirmationTokenHash)
      ) {
        return { kind: "invalid" };
      }
      if (challenge.status !== "pending") return { kind: "already-used" };
      if (challenge.expiresAt <= now) {
        transaction
          .update(authChallenges)
          .set({ status: "expired" })
          .where(eq(authChallenges.id, challenge.id))
          .run();
        return { kind: "expired" };
      }

      transaction
        .update(authChallenges)
        .set({ confirmedAt: now, status: "confirmed" })
        .where(eq(authChallenges.id, challenge.id))
        .run();
      return { kind: "confirmed" };
    },
    { behavior: "immediate" },
  );

export const pollLoginChallenge = (
  { db }: Database,
  token: ParsedOpaqueToken,
  input: { readonly config: AuthConfig; readonly now: number },
): PollOutcome =>
  db.transaction(
    (transaction) => {
      const challenge = transaction
        .select()
        .from(authChallenges)
        .where(eq(authChallenges.id, token.publicId))
        .get();
      if (challenge === undefined || !verifyTokenSecret(token.secret, challenge.pollingTokenHash)) {
        return { kind: "invalid" };
      }
      if (challenge.status === "expired") return { kind: "expired" };
      if (challenge.status === "consumed") return { kind: "already-used" };
      if (challenge.expiresAt <= input.now) {
        transaction
          .update(authChallenges)
          .set({ status: "expired" })
          .where(eq(authChallenges.id, challenge.id))
          .run();
        return { kind: "expired" };
      }
      if (challenge.status === "pending") {
        transaction
          .update(authChallenges)
          .set({ attempts: sql`${authChallenges.attempts} + 1` })
          .where(eq(authChallenges.id, challenge.id))
          .run();
        return { expiresAt: challenge.expiresAt, kind: "pending" };
      }

      const tokens = issueSession(transaction, challenge.email, input);
      transaction
        .update(authChallenges)
        .set({ consumedAt: input.now, status: "consumed" })
        .where(eq(authChallenges.id, challenge.id))
        .run();
      return { kind: "authenticated", tokens };
    },
    { behavior: "immediate" },
  );

export const findAccessIdentity = (
  { db }: Database,
  token: ParsedOpaqueToken,
  now: number,
): SessionOutcome => {
  const session = db.select().from(sessions).where(eq(sessions.id, token.publicId)).get();
  if (session === undefined || !verifyTokenSecret(token.secret, session.accessTokenHash)) {
    return { kind: "invalid" };
  }
  if (session.revokedAt !== null) return { kind: "revoked" };
  if (session.accessExpiresAt <= now) return { kind: "expired" };

  const user = db.select().from(users).where(eq(users.id, session.userId)).get();
  if (user === undefined) return { kind: "invalid" };
  return {
    kind: "authenticated",
    identity: {
      accessExpiresAt: session.accessExpiresAt,
      email: user.email,
      sessionId: session.id,
      userId: user.id,
    },
  };
};

export const rotateRefreshToken = (
  { db }: Database,
  token: ParsedOpaqueToken,
  input: { readonly config: AuthConfig; readonly now: number },
): RefreshOutcome =>
  db.transaction(
    (transaction) => {
      const refreshToken = transaction
        .select()
        .from(sessionRefreshTokens)
        .where(eq(sessionRefreshTokens.id, token.publicId))
        .get();
      if (refreshToken === undefined || !verifyTokenSecret(token.secret, refreshToken.tokenHash)) {
        return { kind: "invalid" };
      }
      const session = transaction
        .select()
        .from(sessions)
        .where(eq(sessions.id, refreshToken.sessionId))
        .get();
      if (session === undefined) return { kind: "invalid" };
      if (refreshToken.status === "rotated") {
        revokeSessionFamily(transaction, session.familyId, input.now);
        return { kind: "replay" };
      }
      if (session.revokedAt !== null || refreshToken.status === "revoked") {
        return { kind: "revoked" };
      }
      if (refreshToken.expiresAt <= input.now || session.refreshExpiresAt <= input.now) {
        revokeSessionFamily(transaction, session.familyId, input.now);
        return { kind: "expired" };
      }

      return {
        kind: "rotated",
        tokens: rotateActiveRefresh(transaction, session, refreshToken, input),
      };
    },
    { behavior: "immediate" },
  );

export const revokeByAccessToken = (
  { db }: Database,
  token: ParsedOpaqueToken,
  now: number,
): LogoutOutcome =>
  db.transaction(
    (transaction) => {
      const session = transaction
        .select()
        .from(sessions)
        .where(eq(sessions.id, token.publicId))
        .get();
      if (session === undefined || !verifyTokenSecret(token.secret, session.accessTokenHash)) {
        return { kind: "invalid" };
      }

      revokeSessionFamily(transaction, session.familyId, now);
      return { kind: "logged-out" };
    },
    { behavior: "immediate" },
  );

const getRateLimitRetryAt = (
  transaction: AuthTransaction,
  input: {
    readonly config: AuthConfig;
    readonly email: string;
    readonly now: number;
    readonly requestIpHash: string;
  },
) => {
  const since = input.now - input.config.rateLimitWindowMs;
  const emailAttempts = transaction
    .select({ createdAt: authChallenges.createdAt })
    .from(authChallenges)
    .where(and(eq(authChallenges.email, input.email), gt(authChallenges.createdAt, since)))
    .orderBy(asc(authChallenges.createdAt))
    .limit(input.config.maxChallengesPerEmail)
    .all();
  const ipAttempts = transaction
    .select({ createdAt: authChallenges.createdAt })
    .from(authChallenges)
    .where(
      and(
        eq(authChallenges.requestIpHash, input.requestIpHash),
        gt(authChallenges.createdAt, since),
      ),
    )
    .orderBy(asc(authChallenges.createdAt))
    .limit(input.config.maxChallengesPerIp)
    .all();
  const retryTimes = [
    getRetryAt(emailAttempts, input.config.maxChallengesPerEmail, input.config.rateLimitWindowMs),
    getRetryAt(ipAttempts, input.config.maxChallengesPerIp, input.config.rateLimitWindowMs),
  ].filter((value): value is number => value !== undefined);

  return retryTimes.length === 0 ? undefined : Math.max(...retryTimes);
};

const getRetryAt = (
  attempts: ReadonlyArray<{ readonly createdAt: number }>,
  maximum: number,
  windowMs: number,
) =>
  attempts.length < maximum || attempts[0] === undefined
    ? undefined
    : attempts[0].createdAt + windowMs;

const issueSession = (
  transaction: AuthTransaction,
  email: string,
  input: { readonly config: AuthConfig; readonly now: number },
): AuthenticatedTokens => {
  const existingUser = transaction.select().from(users).where(eq(users.email, email)).get();
  const userId = existingUser?.id ?? randomUUID();
  if (existingUser === undefined) {
    transaction
      .insert(users)
      .values({ createdAt: input.now, email, id: userId, updatedAt: input.now })
      .run();
  }

  const accessToken = createOpaqueToken();
  const refreshToken = createOpaqueToken();
  const accessExpiresAt = input.now + input.config.accessTokenTtlMs;
  const refreshExpiresAt = input.now + input.config.refreshTokenTtlMs;
  transaction
    .insert(sessions)
    .values({
      accessExpiresAt,
      accessTokenHash: hashTokenSecret(accessToken.secret),
      createdAt: input.now,
      familyId: randomUUID(),
      id: accessToken.publicId,
      refreshExpiresAt,
      updatedAt: input.now,
      userId,
    })
    .run();
  transaction
    .insert(sessionRefreshTokens)
    .values({
      createdAt: input.now,
      expiresAt: refreshExpiresAt,
      id: refreshToken.publicId,
      sessionId: accessToken.publicId,
      status: "active",
      tokenHash: hashTokenSecret(refreshToken.secret),
    })
    .run();

  return {
    accessExpiresAt,
    accessToken: formatOpaqueToken(accessToken),
    refreshExpiresAt,
    refreshToken: formatOpaqueToken(refreshToken),
    status: "authenticated",
  };
};

const rotateActiveRefresh = (
  transaction: AuthTransaction,
  session: typeof sessions.$inferSelect,
  currentRefresh: typeof sessionRefreshTokens.$inferSelect,
  input: { readonly config: AuthConfig; readonly now: number },
): AuthenticatedTokens => {
  const accessToken = new ParsedOpaqueToken(session.id, createOpaqueToken().secret);
  const refreshToken = createOpaqueToken();
  const accessExpiresAt = input.now + input.config.accessTokenTtlMs;
  transaction
    .update(sessionRefreshTokens)
    .set({ rotatedAt: input.now, status: "rotated" })
    .where(eq(sessionRefreshTokens.id, currentRefresh.id))
    .run();
  transaction
    .insert(sessionRefreshTokens)
    .values({
      createdAt: input.now,
      expiresAt: session.refreshExpiresAt,
      id: refreshToken.publicId,
      sessionId: session.id,
      status: "active",
      tokenHash: hashTokenSecret(refreshToken.secret),
    })
    .run();
  transaction
    .update(sessions)
    .set({
      accessExpiresAt,
      accessTokenHash: hashTokenSecret(accessToken.secret),
      updatedAt: input.now,
    })
    .where(eq(sessions.id, session.id))
    .run();

  return {
    accessExpiresAt,
    accessToken: formatOpaqueToken(accessToken),
    refreshExpiresAt: session.refreshExpiresAt,
    refreshToken: formatOpaqueToken(refreshToken),
    status: "authenticated",
  };
};

const revokeSessionFamily = (transaction: AuthTransaction, familyId: string, now: number) => {
  const sessionIds = transaction
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.familyId, familyId))
    .all()
    .map(({ id }) => id);
  transaction
    .update(sessions)
    .set({ revokedAt: sql`coalesce(${sessions.revokedAt}, ${now})`, updatedAt: now })
    .where(eq(sessions.familyId, familyId))
    .run();
  if (sessionIds.length === 0) return;
  transaction
    .update(sessionRefreshTokens)
    .set({ status: "revoked" })
    .where(inArray(sessionRefreshTokens.sessionId, sessionIds))
    .run();
};
