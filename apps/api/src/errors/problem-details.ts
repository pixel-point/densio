import type { ProblemDetails } from "@densio/shared";
import { Schema } from "effect";

export class ApiProblem extends Schema.TaggedErrorClass<ApiProblem>()("ApiProblem", {
  code: Schema.String,
  detail: Schema.String,
  details: Schema.optionalKey(Schema.Json),
  jobId: Schema.NullOr(Schema.String),
  retryable: Schema.Boolean,
  status: Schema.Number,
  suggestedAction: Schema.String,
  title: Schema.String,
}) {}

interface ProblemInput {
  readonly code: string;
  readonly detail: string;
  readonly details?: Schema.Json;
  readonly jobId?: string;
  readonly retryable: boolean;
  readonly status: number;
  readonly suggestedAction: string;
  readonly title: string;
}

export interface ProblemDescriptor {
  readonly code: string;
  readonly description: string;
  readonly status: number;
  readonly title: string;
}

type DescriptorProblemInput = Omit<ProblemInput, "code" | "status" | "title">;

export const defineProblem = <const Descriptor extends ProblemDescriptor>(descriptor: Descriptor) =>
  Object.freeze(descriptor);

export const makeDescriptorProblem = (
  descriptor: ProblemDescriptor,
  input: DescriptorProblemInput,
) =>
  makeProblem({
    ...input,
    code: descriptor.code,
    status: descriptor.status,
    title: descriptor.title,
  });

export const makeProblem = (input: ProblemInput) =>
  new ApiProblem({
    ...input,
    jobId: input.jobId ?? null,
  });

export const toProblemDetails = (problem: ApiProblem, correlationId: string): ProblemDetails => ({
  code: problem.code,
  correlationId,
  detail: problem.detail,
  ...(problem.details === undefined ? {} : { details: problem.details }),
  retryable: problem.retryable,
  schemaVersion: 1,
  status: problem.status,
  suggestedAction: problem.suggestedAction,
  title: problem.title,
  type: "about:blank",
  ...(problem.jobId === null ? {} : { jobId: problem.jobId }),
});

export const invalidRequestProblemDescriptor = defineProblem({
  code: "INVALID_REQUEST",
  description: "The request body or required header is invalid.",
  status: 400,
  title: "Invalid request",
});

export const requestTooLargeProblemDescriptor = defineProblem({
  code: "REQUEST_TOO_LARGE",
  description: "The JSON request body is too large.",
  status: 413,
  title: "Request body too large",
});

export const internalErrorProblemDescriptor = defineProblem({
  code: "INTERNAL_ERROR",
  description: "The server could not complete the request.",
  status: 500,
  title: "Internal server error",
});

export const unexpectedProblem = (_cause: unknown) =>
  makeDescriptorProblem(internalErrorProblemDescriptor, {
    detail: "The server could not complete the request.",
    retryable: true,
    suggestedAction: "Retry once, then contact the server operator with the correlation ID.",
  });
