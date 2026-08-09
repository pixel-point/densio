import {
  AuthChallengeUnavailable,
  AuthRateLimitExceeded,
  AuthSessionUnauthorized,
  RefreshTokenReplay,
} from "../../auth/auth-errors.ts";
import { InvalidEmailAddress } from "../../auth/email-address.ts";
import { defineProblem, makeDescriptorProblem } from "../../errors/problem-details.ts";

export const invalidEmailProblemDescriptor = defineProblem({
  code: "INVALID_EMAIL",
  description: "The email address is invalid.",
  status: 400,
  title: "Invalid email address",
});

export const authRequiredProblemDescriptor = defineProblem({
  code: "AUTH_REQUIRED",
  description: "A valid bearer token is required.",
  status: 401,
  title: "Authentication required",
});

export const authRateLimitProblemDescriptor = defineProblem({
  code: "AUTH_RATE_LIMITED",
  description: "The login rate limit was exceeded.",
  status: 429,
  title: "Login rate limit exceeded",
});

export const authChallengeInvalidProblemDescriptor = defineProblem({
  code: "AUTH_CHALLENGE_INVALID",
  description: "The login confirmation is invalid.",
  status: 400,
  title: "Invalid login confirmation",
});

export const authChallengeUsedProblemDescriptor = defineProblem({
  code: "AUTH_CHALLENGE_USED",
  description: "The login confirmation has already been used.",
  status: 409,
  title: "Login already completed",
});

export const authChallengeExpiredProblemDescriptor = defineProblem({
  code: "AUTH_CHALLENGE_EXPIRED",
  description: "The login confirmation has expired.",
  status: 410,
  title: "Login expired",
});

export const refreshReplayProblemDescriptor = defineProblem({
  code: "AUTH_REFRESH_REPLAY",
  description: "The refresh token was expired, revoked, or reused.",
  status: 401,
  title: "Session revoked",
});

export const authProblem = (error: unknown) => {
  if (error instanceof InvalidEmailAddress) return invalidEmailProblem();
  if (error instanceof AuthRateLimitExceeded) return authRateLimitProblem();
  if (error instanceof AuthChallengeUnavailable) return authChallengeProblem(error.reason);
  if (error instanceof AuthSessionUnauthorized) return authRequiredProblem();
  if (error instanceof RefreshTokenReplay) return refreshReplayProblem();
  return undefined;
};

const invalidEmailProblem = () =>
  makeDescriptorProblem(invalidEmailProblemDescriptor, {
    detail: "Enter a valid email address.",
    retryable: false,
    suggestedAction: "Correct the email address and retry login.",
  });

export const authRequiredProblem = () =>
  makeDescriptorProblem(authRequiredProblemDescriptor, {
    detail: "A valid access token is required.",
    retryable: false,
    suggestedAction: "Run ffmpeg-api auth login, then retry the command.",
  });

const authRateLimitProblem = () =>
  makeDescriptorProblem(authRateLimitProblemDescriptor, {
    detail: "Too many login links were requested.",
    retryable: true,
    suggestedAction: "Wait before requesting another login link.",
  });

const authChallengeProblem = (reason: "invalid" | "expired" | "already-used") => {
  if (reason === "expired") {
    return makeDescriptorProblem(authChallengeExpiredProblemDescriptor, {
      detail: "The login confirmation has expired.",
      retryable: false,
      suggestedAction: "Start a new ffmpeg-api auth login.",
    });
  }
  if (reason === "already-used") {
    return makeDescriptorProblem(authChallengeUsedProblemDescriptor, {
      detail: "The login confirmation has already been used.",
      retryable: false,
      suggestedAction: "Continue with the issued token or start a new login.",
    });
  }
  return makeDescriptorProblem(authChallengeInvalidProblemDescriptor, {
    detail: "The login confirmation is invalid.",
    retryable: false,
    suggestedAction: "Start a new ffmpeg-api auth login.",
  });
};

const refreshReplayProblem = () =>
  makeDescriptorProblem(refreshReplayProblemDescriptor, {
    detail: "A rotated refresh token was reused, so its session was revoked.",
    retryable: false,
    suggestedAction: "Run ffmpeg-api auth login again.",
  });
