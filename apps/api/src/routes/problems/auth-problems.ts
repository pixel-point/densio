import {
  AuthChallengeUnavailable,
  AuthRateLimitExceeded,
  AuthSessionUnauthorized,
  RefreshTokenReplay,
} from "../../auth/auth-errors.ts";
import { InvalidEmailAddress } from "../../auth/email-address.ts";
import { makeProblem } from "../../errors/problem-details.ts";

export const authProblem = (error: unknown) => {
  if (error instanceof InvalidEmailAddress) return invalidEmailProblem();
  if (error instanceof AuthRateLimitExceeded) return authRateLimitProblem();
  if (error instanceof AuthChallengeUnavailable) return authChallengeProblem(error.reason);
  if (error instanceof AuthSessionUnauthorized) return authRequiredProblem();
  if (error instanceof RefreshTokenReplay) return refreshReplayProblem();
  return undefined;
};

const invalidEmailProblem = () =>
  makeProblem({
    code: "INVALID_EMAIL",
    detail: "Enter a valid email address.",
    retryable: false,
    status: 400,
    suggestedAction: "Correct the email address and retry login.",
    title: "Invalid email address",
  });

export const authRequiredProblem = () =>
  makeProblem({
    code: "AUTH_REQUIRED",
    detail: "A valid access token is required.",
    retryable: false,
    status: 401,
    suggestedAction: "Run ffmpeg-api auth login, then retry the command.",
    title: "Authentication required",
  });

const authRateLimitProblem = () =>
  makeProblem({
    code: "AUTH_RATE_LIMITED",
    detail: "Too many login links were requested.",
    retryable: true,
    status: 429,
    suggestedAction: "Wait before requesting another login link.",
    title: "Login rate limit exceeded",
  });

const authChallengeProblem = (reason: "invalid" | "expired" | "already-used") => {
  if (reason === "expired") {
    return makeProblem({
      code: "AUTH_CHALLENGE_EXPIRED",
      detail: "The login confirmation has expired.",
      retryable: false,
      status: 410,
      suggestedAction: "Start a new ffmpeg-api auth login.",
      title: "Login expired",
    });
  }
  if (reason === "already-used") {
    return makeProblem({
      code: "AUTH_CHALLENGE_USED",
      detail: "The login confirmation has already been used.",
      retryable: false,
      status: 409,
      suggestedAction: "Continue with the issued token or start a new login.",
      title: "Login already completed",
    });
  }
  return makeProblem({
    code: "AUTH_CHALLENGE_INVALID",
    detail: "The login confirmation is invalid.",
    retryable: false,
    status: 400,
    suggestedAction: "Start a new ffmpeg-api auth login.",
    title: "Invalid login confirmation",
  });
};

const refreshReplayProblem = () =>
  makeProblem({
    code: "AUTH_REFRESH_REPLAY",
    detail: "A rotated refresh token was reused, so its session was revoked.",
    retryable: false,
    status: 401,
    suggestedAction: "Run ffmpeg-api auth login again.",
    title: "Session revoked",
  });
