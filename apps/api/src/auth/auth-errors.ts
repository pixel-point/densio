import { Schema } from "effect";

export class AuthStorageError extends Schema.TaggedErrorClass<AuthStorageError>()(
  "AuthStorageError",
  {
    cause: Schema.Defect(),
    operation: Schema.String,
  },
) {}

export class AuthRateLimitExceeded extends Schema.TaggedErrorClass<AuthRateLimitExceeded>()(
  "AuthRateLimitExceeded",
  { retryAt: Schema.Number },
) {}

export class AuthChallengeUnavailable extends Schema.TaggedErrorClass<AuthChallengeUnavailable>()(
  "AuthChallengeUnavailable",
  {
    reason: Schema.Literals(["invalid", "expired", "already-used"]),
  },
) {}

export class AuthSessionUnauthorized extends Schema.TaggedErrorClass<AuthSessionUnauthorized>()(
  "AuthSessionUnauthorized",
  {
    reason: Schema.Literals(["invalid", "expired", "revoked"]),
  },
) {}

export class RefreshTokenReplay extends Schema.TaggedErrorClass<RefreshTokenReplay>()(
  "RefreshTokenReplay",
  {},
) {}
