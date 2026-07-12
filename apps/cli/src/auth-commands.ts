import {
  AuthPollResponseSchema,
  AuthStartResponseSchema,
  AuthStatusSchema,
  EmailAddressSchema,
  LogoutResponseSchema,
  successEnvelope,
} from "@ffmpeg-api/shared";
import { Effect, Schema } from "effect";

import { authorizationHeaders } from "./authentication.ts";
import {
  clearCredentials,
  credentialApiOrigin,
  readCredentials,
  writeCredentials,
} from "./config.ts";
import {
  authChallengeExpiredError,
  CliProblemError,
  CliUsageError,
  loginInterruptedError,
} from "./cli-errors.ts";
import { jsonRequest, requestJson } from "./http-client.ts";
import { emitStatusEvent, emitSuccess } from "./render.ts";
import { pollUntilComplete } from "./polling.ts";
import { CLI_EXIT_CODES } from "./output.ts";
import type { CliRuntime } from "./runtime.ts";

const decodeEmail = Schema.decodeUnknownEffect(EmailAddressSchema);
const decodeAuthStart = Schema.decodeUnknownEffect(successEnvelope(AuthStartResponseSchema));
const decodeAuthPoll = Schema.decodeUnknownEffect(successEnvelope(AuthPollResponseSchema));
const decodeAuthStatus = Schema.decodeUnknownEffect(successEnvelope(AuthStatusSchema));
const decodeLogout = Schema.decodeUnknownEffect(successEnvelope(LogoutResponseSchema));

export const runAuthCommand = async (
  argumentsInput: ReadonlyArray<string>,
  runtime: CliRuntime,
) => {
  const [command, ...rest] = argumentsInput;
  if (command === "login") return login(rest, runtime);
  if (command === "status") return status(rest, runtime);
  if (command === "logout") return logout(rest, runtime);
  throw new CliUsageError("auth requires login, status, or logout.");
};

const status = async (argumentsInput: ReadonlyArray<string>, runtime: CliRuntime) => {
  if (argumentsInput.length > 0) throw new CliUsageError("auth status accepts no arguments.");
  const headers = await authorizationHeaders(runtime, false);
  const response = await requestJson(
    runtime,
    "/v1/auth/status",
    { headers, method: "GET" },
    decodeAuthStatus,
  );
  const humanText = response.data.authenticated
    ? `Authenticated as ${response.data.user.email} (${response.data.user.plan}).\n`
    : "Not authenticated.\n";
  emitSuccess(runtime, response, humanText);
};

const logout = async (argumentsInput: ReadonlyArray<string>, runtime: CliRuntime) => {
  if (argumentsInput.length > 0) throw new CliUsageError("auth logout accepts no arguments.");
  const credentials = await readCredentials(runtime.credentialsPath);
  if (credentials === undefined) {
    emitSuccess(runtime, localLogoutEnvelope(), "Already logged out.\n");
    return;
  }
  const headers = await authorizationHeaders(runtime);
  const response = await requestJson(
    runtime,
    "/v1/auth/logout",
    jsonRequest("POST", undefined, headers),
    decodeLogout,
  );
  await clearCredentials(runtime.credentialsPath);
  emitSuccess(runtime, response, "Logged out.\n");
};

const localLogoutEnvelope = () => ({
  correlationId: "local",
  data: { revoked: true as const },
  ok: true as const,
  schemaVersion: 1 as const,
});

const login = async (argumentsInput: ReadonlyArray<string>, runtime: CliRuntime) => {
  const [emailInput, ...extra] = argumentsInput;
  if (emailInput === undefined || extra.length > 0) {
    throw new CliUsageError("auth login requires exactly one email address.");
  }
  const email = await Effect.runPromise(decodeEmail(emailInput)).catch(() =>
    Promise.reject(new CliUsageError("auth login requires a valid email address.")),
  );
  if (runtime.signal?.aborted === true) throw loginInterruptedError();
  const start = await requestJson(
    runtime,
    "/v1/auth/login",
    jsonRequest("POST", { email }),
    decodeAuthStart,
  ).catch((cause: unknown) => {
    if (runtime.signal?.aborted === true) throw loginInterruptedError();
    throw cause;
  });
  emitStatusEvent(
    runtime,
    { state: "waiting-confirmation", type: "progress" },
    "Waiting for email confirmation.\n",
  );
  const tokens = await pollForConfirmation(start.data, runtime);
  await writeCredentials(runtime.credentialsPath, {
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    apiUrl: credentialApiOrigin(runtime.apiUrl),
    refreshToken: tokens.refreshToken,
  });
  emitSuccess(
    runtime,
    {
      correlationId: start.correlationId,
      data: { authenticated: true, expiresAt: tokens.accessTokenExpiresAt },
      ok: true,
      schemaVersion: 1,
    },
    "Authenticated.\n",
  );
};

const pollForConfirmation = async (
  start: typeof AuthStartResponseSchema.Type,
  runtime: CliRuntime,
) =>
  pollUntilComplete({
    deadlineAt: Date.parse(start.expiresAt),
    decide: (response) =>
      response.data.status === "confirmed"
        ? { kind: "complete", value: response.data }
        : {
            delayMilliseconds: response.data.pollAfterSeconds * 1_000,
            kind: "pending",
          },
    initialDelayMilliseconds: start.pollAfterSeconds * 1_000,
    interruptedError: loginInterruptedError,
    isRetryableFailure: (cause) =>
      cause instanceof CliProblemError &&
      (cause.exitCode === CLI_EXIT_CODES.network || cause.problem.retryable),
    poll: () =>
      requestJson(
        runtime,
        "/v1/auth/poll",
        jsonRequest("POST", { pollToken: start.pollToken }),
        decodeAuthPoll,
      ),
    runtime,
    timeoutError: authChallengeExpiredError,
  });
