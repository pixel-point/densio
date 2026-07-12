import type { ProblemDetails } from "@ffmpeg-api/shared";
import { Schema } from "effect";

export class ApiProblem extends Schema.TaggedErrorClass<ApiProblem>()("ApiProblem", {
  code: Schema.String,
  detail: Schema.String,
  jobId: Schema.NullOr(Schema.String),
  retryable: Schema.Boolean,
  status: Schema.Number,
  suggestedAction: Schema.String,
  title: Schema.String,
}) {}

interface ProblemInput {
  readonly code: string;
  readonly detail: string;
  readonly jobId?: string;
  readonly retryable: boolean;
  readonly status: number;
  readonly suggestedAction: string;
  readonly title: string;
}

export const makeProblem = (input: ProblemInput) =>
  new ApiProblem({
    ...input,
    jobId: input.jobId ?? null,
  });

export const toProblemDetails = (problem: ApiProblem, correlationId: string): ProblemDetails => ({
  code: problem.code,
  correlationId,
  detail: problem.detail,
  retryable: problem.retryable,
  schemaVersion: 1,
  status: problem.status,
  suggestedAction: problem.suggestedAction,
  title: problem.title,
  type: "about:blank",
  ...(problem.jobId === null ? {} : { jobId: problem.jobId }),
});

export const unexpectedProblem = (_cause: unknown) =>
  makeProblem({
    code: "INTERNAL_ERROR",
    detail: "The server could not complete the request.",
    retryable: true,
    status: 500,
    suggestedAction: "Retry once, then contact the server operator with the correlation ID.",
    title: "Internal server error",
  });
