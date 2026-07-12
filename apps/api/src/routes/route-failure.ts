import { Effect } from "effect";

import { AuthStorageError } from "../auth/auth-errors.ts";
import { BillingStorageError } from "../billing/billing-errors.ts";
import { ArtifactRepositoryError } from "../database/artifact-repository.ts";
import { ApiProblem, unexpectedProblem } from "../errors/problem-details.ts";
import { JobRepositoryError } from "../jobs/job-service.ts";
import { StorageOperationError } from "../storage/workspace.ts";
import { authProblem } from "./problems/auth-problems.ts";
import { billingProblem } from "./problems/billing-problems.ts";
import { jobProblem } from "./problems/job-problems.ts";
import { storageProblem } from "./problems/storage-problems.ts";

export interface RouteFailureReport {
  readonly correlationId: string;
  readonly errorTag: string;
  readonly operation?: string;
}

export type RouteFailureReporter = (report: RouteFailureReport) => void | Promise<void>;

export const classifyRouteFailure = (error: unknown, correlationId: string) => {
  if (error instanceof ApiProblem) return { problem: error };
  const expected =
    authProblem(error) ?? billingProblem(error) ?? jobProblem(error) ?? storageProblem(error);
  if (expected !== undefined) return { problem: expected };
  return {
    problem: unexpectedProblem(error),
    report: internalFailureReport(error, correlationId),
  };
};

export const reportRouteFailure: RouteFailureReporter = (report) =>
  Effect.runPromise(
    Effect.logError("API request failed.", report).pipe(
      Effect.annotateLogs("correlationId", report.correlationId),
    ),
  );

const internalFailureReport = (error: unknown, correlationId: string): RouteFailureReport => {
  const operation = internalOperation(error);
  return {
    correlationId,
    errorTag: safeErrorTag(error),
    ...(operation === undefined ? {} : { operation }),
  };
};

const internalOperation = (error: unknown) => {
  if (
    error instanceof AuthStorageError ||
    error instanceof BillingStorageError ||
    error instanceof JobRepositoryError ||
    error instanceof ArtifactRepositoryError ||
    error instanceof StorageOperationError
  ) {
    return error.operation;
  }
  return undefined;
};

const safeErrorTag = (error: unknown) => {
  if (error instanceof Error) return safeTag(error.name);
  return "UnexpectedError";
};

const safeTag = (value: string) =>
  /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(value) ? value : "UnexpectedError";
