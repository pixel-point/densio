import { Context, Effect } from "effect";

import type { Database } from "../database/database.ts";
import {
  AuthChallengeUnavailable,
  AuthRateLimitExceeded,
  AuthSessionUnauthorized,
  AuthStorageError,
  RefreshTokenReplay,
} from "./auth-errors.ts";
import {
  type AccessIdentity,
  type AuthenticatedTokens,
  type AuthConfig,
  confirmLoginChallenge,
  createLoginChallenge,
  findAccessIdentity,
  pollLoginChallenge,
  revokeByAccessToken,
  rotateRefreshToken,
  type RequestedLogin,
} from "./auth-repository.ts";
import { type InvalidEmailAddress, parseEmailAddress } from "./email-address.ts";
import type { MagicLinkSealer } from "./magic-link-secret.ts";
import { parseOpaqueToken } from "./opaque-token.ts";

export type { AuthConfig } from "./auth-repository.ts";

export interface RequestLoginInput {
  readonly config: AuthConfig;
  readonly email: unknown;
  readonly now: number;
  readonly requestIpHash: string;
}

export interface ConfirmInput {
  readonly confirmationToken: unknown;
  readonly now: number;
}

export interface PollInput {
  readonly config: AuthConfig;
  readonly now: number;
  readonly pollingToken: unknown;
}

export interface AccessInput {
  readonly accessToken: unknown;
  readonly now: number;
}

export interface RefreshInput {
  readonly config: AuthConfig;
  readonly now: number;
  readonly refreshToken: unknown;
}

export interface LogoutInput {
  readonly accessToken: unknown;
  readonly now: number;
}

export interface AuthServiceDefinition {
  readonly confirm: (
    input: ConfirmInput,
  ) => Effect.Effect<{ readonly status: "confirmed" }, AuthChallengeUnavailable | AuthStorageError>;
  readonly logout: (
    input: LogoutInput,
  ) => Effect.Effect<void, AuthSessionUnauthorized | AuthStorageError>;
  readonly lookupAccess: (
    input: AccessInput,
  ) => Effect.Effect<AccessIdentity, AuthSessionUnauthorized | AuthStorageError>;
  readonly poll: (
    input: PollInput,
  ) => Effect.Effect<
    { readonly expiresAt: number; readonly status: "pending" } | AuthenticatedTokens,
    AuthChallengeUnavailable | AuthStorageError
  >;
  readonly refresh: (
    input: RefreshInput,
  ) => Effect.Effect<
    AuthenticatedTokens,
    AuthSessionUnauthorized | AuthStorageError | RefreshTokenReplay
  >;
  readonly requestLogin: (
    input: RequestLoginInput,
  ) => Effect.Effect<
    RequestedLogin,
    InvalidEmailAddress | AuthRateLimitExceeded | AuthStorageError
  >;
}

export class AuthService extends Context.Service<AuthService, AuthServiceDefinition>()(
  "ffmpeg-api/auth/AuthService",
) {}

export const makeAuthService = (database: Database, sealMagicLink: MagicLinkSealer) => {
  const requestLogin = Effect.fn("AuthService.requestLogin")(function* (input: RequestLoginInput) {
    const email = yield* parseEmailAddress(input.email);
    const outcome = yield* tryStorage("request-login", () =>
      createLoginChallenge(database, { ...input, email, sealMagicLink }),
    );
    if (outcome.kind === "rate-limited") {
      return yield* new AuthRateLimitExceeded({ retryAt: outcome.retryAt });
    }
    return outcome.login;
  });

  const confirm = Effect.fn("AuthService.confirm")(function* (input: ConfirmInput) {
    const token = yield* parseChallengeToken(input.confirmationToken);
    const outcome = yield* tryStorage("confirm", () =>
      confirmLoginChallenge(database, token, input.now),
    );
    if (outcome.kind === "confirmed") {
      return { status: "confirmed" as const };
    }
    return yield* new AuthChallengeUnavailable({ reason: outcome.kind });
  });

  const poll = Effect.fn("AuthService.poll")(function* (input: PollInput) {
    const token = yield* parseChallengeToken(input.pollingToken);
    const outcome = yield* tryStorage("poll", () => pollLoginChallenge(database, token, input));
    if (outcome.kind === "pending") {
      return { expiresAt: outcome.expiresAt, status: "pending" as const };
    }
    if (outcome.kind === "authenticated") return outcome.tokens;
    return yield* new AuthChallengeUnavailable({ reason: outcome.kind });
  });

  const lookupAccess = Effect.fn("AuthService.lookupAccess")(function* (input: AccessInput) {
    const token = yield* parseSessionToken(input.accessToken);
    const outcome = yield* tryStorage("lookup-access", () =>
      findAccessIdentity(database, token, input.now),
    );
    if (outcome.kind === "authenticated") return outcome.identity;
    return yield* new AuthSessionUnauthorized({ reason: outcome.kind });
  });

  const refresh = Effect.fn("AuthService.refresh")(function* (input: RefreshInput) {
    const token = yield* parseSessionToken(input.refreshToken);
    const outcome = yield* tryStorage("refresh", () => rotateRefreshToken(database, token, input));
    if (outcome.kind === "rotated") return outcome.tokens;
    if (outcome.kind === "replay") return yield* new RefreshTokenReplay();
    return yield* new AuthSessionUnauthorized({ reason: outcome.kind });
  });

  const logout = Effect.fn("AuthService.logout")(function* (input: LogoutInput) {
    const token = yield* parseSessionToken(input.accessToken);
    const outcome = yield* tryStorage("logout", () =>
      revokeByAccessToken(database, token, input.now),
    );
    if (outcome.kind === "logged-out") return;
    return yield* new AuthSessionUnauthorized({ reason: "invalid" });
  });

  return AuthService.of({
    confirm,
    logout,
    lookupAccess,
    poll,
    refresh,
    requestLogin,
  });
};

const tryStorage = Effect.fn("AuthService.tryStorage")(
  <Value>(operation: string, evaluate: () => Value) =>
    Effect.try({
      catch: (cause) => new AuthStorageError({ cause, operation }),
      try: evaluate,
    }),
);

const parseChallengeToken = Effect.fn("AuthService.parseChallengeToken")((input: unknown) =>
  parseOpaqueToken(input).pipe(
    Effect.mapError(() => new AuthChallengeUnavailable({ reason: "invalid" })),
  ),
);

const parseSessionToken = Effect.fn("AuthService.parseSessionToken")((input: unknown) =>
  parseOpaqueToken(input).pipe(
    Effect.mapError(() => new AuthSessionUnauthorized({ reason: "invalid" })),
  ),
);
