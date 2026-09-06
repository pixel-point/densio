import { Schema } from "effect";

import { IdentifierSchema, IsoTimestampSchema, PositiveFiniteSchema } from "./common-contracts.ts";

export const EmailAddressSchema = Schema.String.check(
  Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
);
export type EmailAddress = typeof EmailAddressSchema.Type;

export const AuthLoginRequestSchema = Schema.Struct({ email: EmailAddressSchema });
export const AuthPollRequestSchema = Schema.Struct({ pollToken: Schema.NonEmptyString });
export const AuthConfirmRequestSchema = Schema.Struct({
  token: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
});
export const AuthConfirmResponseSchema = Schema.Struct({ status: Schema.Literal("confirmed") });

export const AuthStartResponseSchema = Schema.Struct({
  challengeId: IdentifierSchema,
  pollToken: Schema.NonEmptyString,
  expiresAt: IsoTimestampSchema,
  pollAfterSeconds: PositiveFiniteSchema,
});
export type AuthStartResponse = typeof AuthStartResponseSchema.Type;

const AuthPendingResponseSchema = Schema.Struct({
  status: Schema.Literal("pending"),
  expiresAt: IsoTimestampSchema,
  pollAfterSeconds: PositiveFiniteSchema,
});

export const AuthTokensSchema = Schema.Struct({
  accessToken: Schema.NonEmptyString,
  accessTokenExpiresAt: IsoTimestampSchema,
  refreshToken: Schema.NonEmptyString,
});
export type AuthTokens = typeof AuthTokensSchema.Type;

const AuthConfirmedResponseSchema = Schema.Struct({
  status: Schema.Literal("confirmed"),
  ...AuthTokensSchema.fields,
});

export const AuthPollResponseSchema = Schema.Union([
  AuthPendingResponseSchema,
  AuthConfirmedResponseSchema,
]);
export type AuthPollResponse = typeof AuthPollResponseSchema.Type;

export const BrowserAuthPollResponseSchema = Schema.Union([
  AuthPendingResponseSchema,
  Schema.Struct({
    status: Schema.Literal("confirmed"),
    sessionToken: Schema.NonEmptyString,
    expiresAt: IsoTimestampSchema,
  }),
]);
export type BrowserAuthPollResponse = typeof BrowserAuthPollResponseSchema.Type;

export const AuthUserSchema = Schema.Struct({
  id: IdentifierSchema,
  email: EmailAddressSchema,
});
export type AuthUser = typeof AuthUserSchema.Type;

const AnonymousAuthStatusSchema = Schema.Struct({
  authenticated: Schema.Literal(false),
});

const AuthenticatedAuthStatusSchema = Schema.Struct({
  authenticated: Schema.Literal(true),
  user: AuthUserSchema,
  defaultOrganizationId: IdentifierSchema,
  sessionExpiresAt: IsoTimestampSchema,
});

export const AuthStatusSchema = Schema.Union([
  AnonymousAuthStatusSchema,
  AuthenticatedAuthStatusSchema,
]);
export type AuthStatus = typeof AuthStatusSchema.Type;

export const LogoutResponseSchema = Schema.Struct({ revoked: Schema.Literal(true) });
export type LogoutResponse = typeof LogoutResponseSchema.Type;
