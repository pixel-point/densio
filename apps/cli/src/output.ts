import type { SuccessEnvelope } from "@densio/shared";

export const CLI_EXIT_CODES = {
  success: 0,
  usage: 2,
  authentication: 3,
  entitlement: 4,
  remote: 5,
  network: 6,
  interrupted: 130,
} as const;

export const formatJsonSuccess = (envelope: SuccessEnvelope<unknown>) =>
  `${JSON.stringify({
    ok: envelope.ok,
    schemaVersion: envelope.schemaVersion,
    data: envelope.data,
    correlationId: envelope.correlationId,
  })}\n`;

export const formatJsonProblem = (problem: unknown) => `${JSON.stringify(problem)}\n`;

export const exitCodeForProblem = ({
  code,
  status,
}: {
  readonly code: string;
  readonly status: number;
}) => {
  if (status === 401 || code.startsWith("AUTH_")) return CLI_EXIT_CODES.authentication;
  if (
    code.startsWith("PLAN_") ||
    code.startsWith("EXECUTION_PLAN_") ||
    code === "STORAGE_UPGRADE_REQUIRED" ||
    code === "STORAGE_QUOTA_EXCEEDED" ||
    code === "CREDITS_EXHAUSTED" ||
    code === "CODEC_NOT_ENTITLED" ||
    code === "DURATION_LIMIT_EXCEEDED" ||
    code === "MAX_CREDITS_EXCEEDED" ||
    code === "OUTPUT_LIMIT_EXCEEDED" ||
    code === "OUTPUT_SIZE_LIMIT_EXCEEDED"
  ) {
    return CLI_EXIT_CODES.entitlement;
  }

  return CLI_EXIT_CODES.remote;
};
