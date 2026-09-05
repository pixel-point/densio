import { Option, Predicate, Schema } from "effect";
import type { jobs } from "../database/schema.ts";
import { makeProblem, toProblemDetails } from "../errors/problem-details.ts";

export const toFailedProblem = (job: typeof jobs.$inferSelect, correlationId: string) => {
  const code =
    job.errorCode !== null && /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(job.errorCode)
      ? job.errorCode
      : "JOB_FAILED";
  const stored = decodeStoredFailure(job.errorJson);
  const definition = failureDefinition(code);
  const details = safeFailureDetails(code, stored?.details);
  const problem = makeProblem({
    code,
    detail: definition.detail,
    ...(details === undefined ? {} : { details }),
    jobId: job.id,
    retryable: definition.retryable,
    status: definition.status,
    suggestedAction: definition.suggestedAction,
    title: definition.title,
  });
  return toProblemDetails(problem, correlationId);
};

const StoredFailureSchema = Schema.Struct({
  details: Schema.optionalKey(Schema.Json),
  message: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(1_000))),
});

const decodeStoredFailure = (value: string | null) =>
  value === null
    ? undefined
    : Option.getOrUndefined(
        Schema.decodeUnknownOption(Schema.fromJsonString(StoredFailureSchema))(value),
      );

const failureDefinition = (code: string) => {
  if (code === "CREDITS_EXHAUSTED") {
    return {
      detail: "The analyzed job cost exceeds the account's available monthly credits.",
      retryable: false,
      status: 402,
      suggestedAction: "Wait for the monthly reset or upgrade the account plan.",
      title: "Credits exhausted",
    } as const;
  }
  if (code === "OUTPUT_SIZE_LIMIT_EXCEEDED") {
    return {
      detail: "The encoded outputs exceed the explicit output byte limit.",
      retryable: false,
      status: 413,
      suggestedAction: "Increase maxOutputBytes or choose smaller outputs in a new plan.",
      title: "Output size limit exceeded",
    } as const;
  }
  if (code === "PLAN_DIVERGED") {
    return {
      detail: "Fresh analysis no longer matches the immutable execution plan quote.",
      retryable: false,
      status: 409,
      suggestedAction: "Create a fresh plan from the retained source and review its new quote.",
      title: "Execution plan diverged",
    } as const;
  }
  if (code === "PREPARED_SOURCE_UNAVAILABLE") {
    return {
      detail: "The prepared source retained for this job is no longer available.",
      retryable: false,
      status: 410,
      suggestedAction:
        "Inspect or upload a new source, create a new execution plan, and execute it with a new key.",
      title: "Prepared source unavailable",
    } as const;
  }
  if (code === "JOB_ATTEMPTS_EXHAUSTED") {
    return {
      detail: "The job exceeded its automatic recovery attempts.",
      retryable: true,
      status: 503,
      suggestedAction: "Execute a new plan; contact the operator if the same failure repeats.",
      title: "Recovery attempts exhausted",
    } as const;
  }
  return {
    detail: "The media job could not be completed.",
    retryable: false,
    status: 422,
    suggestedAction: "Check the source media and options, then execute a new plan.",
    title: code === "MEDIA_PROCESS_FAILED" ? "Media process failed" : "Media job failed",
  } as const;
};

const safeFailureDetails = (
  code: string,
  details: Schema.Json | undefined,
): Schema.Json | undefined => {
  if (!Predicate.isObject(details) || Array.isArray(details)) return undefined;
  const keys =
    code === "MEDIA_PROCESS_FAILED"
      ? ["exitCode", "stderrTail"]
      : [
          "actualBytes",
          "analyzedCreditUnits",
          "availableCredits",
          "durationSeconds",
          "estimatedImages",
          "limitBytes",
          "limitSeconds",
          "maxExtractedImages",
          "quotedCreditUnits",
        ];
  const safe = Object.fromEntries(
    keys.flatMap((key) => {
      const value = details[key];
      return typeof value === "number" || typeof value === "string" || value === null
        ? [[key, value]]
        : [];
    }),
  );
  return Object.keys(safe).length === 0 ? undefined : safe;
};
