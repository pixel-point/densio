import type { ProblemDetails } from "@densio/shared";

import { CLI_EXIT_CODES, exitCodeForProblem } from "./output.ts";

const localProblem = (
  code: string,
  detail: string,
  suggestedAction: string,
  status: number,
): ProblemDetails => ({
  code,
  correlationId: "local",
  detail,
  retryable: false,
  schemaVersion: 1,
  status,
  suggestedAction,
  title: code === "CLI_USAGE_ERROR" ? "Invalid command" : "CLI failure",
  type: "about:blank",
});

export class CliProblemError extends Error {
  readonly exitCode: number;
  readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails, exitCode: number = exitCodeForProblem(problem)) {
    super(problem.detail);
    this.name = "CliProblemError";
    this.exitCode = exitCode;
    this.problem = problem;
  }
}

export class CliUsageError extends CliProblemError {
  constructor(detail: string) {
    super(
      localProblem("CLI_USAGE_ERROR", detail, "Run densio --help for command usage.", 400),
      CLI_EXIT_CODES.usage,
    );
    this.name = "CliUsageError";
  }
}

export const networkError = (detail: string) =>
  new CliProblemError(
    localProblem(
      "CLI_NETWORK_ERROR",
      detail,
      "Check the API URL and network connection, then retry.",
      503,
    ),
    CLI_EXIT_CODES.network,
  );

export const invalidResponseError = () =>
  new CliProblemError(
    localProblem(
      "CLI_INVALID_RESPONSE",
      "The API returned a response that does not match the shared contract.",
      "Check API and CLI version compatibility.",
      502,
    ),
  );

export const authenticationRequiredError = () =>
  new CliProblemError(
    localProblem(
      "AUTH_REQUIRED",
      "No CLI credentials are available.",
      "Run densio auth login, then retry the command.",
      401,
    ),
  );

export const credentialLockTimeoutError = () =>
  new CliProblemError(
    localProblem(
      "CLI_CREDENTIAL_LOCK_TIMEOUT",
      "Another CLI process is updating the credentials file.",
      "Retry after the other densio command finishes.",
      503,
    ),
    CLI_EXIT_CODES.network,
  );

export const loginInterruptedError = () =>
  new CliProblemError(
    localProblem(
      "CLI_INTERRUPTED",
      "Stopped waiting for email confirmation.",
      "Run densio auth login again when ready.",
      499,
    ),
    CLI_EXIT_CODES.interrupted,
  );

export const authChallengeExpiredError = () =>
  new CliProblemError(
    localProblem(
      "AUTH_CHALLENGE_EXPIRED",
      "The email confirmation window expired.",
      "Run densio auth login again to request a new link.",
      410,
    ),
  );

export const artifactHashMismatchError = () =>
  new CliProblemError(
    localProblem(
      "ARTIFACT_HASH_MISMATCH",
      "The downloaded artifact does not match its declared SHA-256 digest.",
      "Discard the download and request a fresh artifact URL.",
      422,
    ),
  );

export const artifactDestinationExistsError = () =>
  new CliProblemError(
    localProblem(
      "ARTIFACT_DESTINATION_EXISTS",
      "The artifact output path already exists.",
      "Choose another --output path or explicitly pass --force to replace it.",
      409,
    ),
  );

export const unexpectedCliError = () =>
  new CliProblemError(
    localProblem(
      "CLI_INTERNAL_ERROR",
      "The CLI could not complete the command.",
      "Retry once, then report the CLI version and command if the failure persists.",
      500,
    ),
    CLI_EXIT_CODES.remote,
  );
