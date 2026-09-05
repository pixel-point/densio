import { describe, expect, it } from "vitest";

import {
  defineProblem,
  makeDescriptorProblem,
  makeProblem,
  toProblemDetails,
  unexpectedProblem,
} from "../src/errors/problem-details.ts";
import { ExecutionPlanCreditsUnavailable } from "../src/execution-plans/execution-plan-errors.ts";
import { executionPlanProblem } from "../src/routes/problems/execution-plan-problems.ts";

describe("problem details", () => {
  it("creates schema-versioned actionable RFC 9457 responses", () => {
    const problem = makeProblem({
      code: "AUTH_REQUIRED",
      detail: "Authenticate before submitting a job.",
      details: { command: "densio auth login" },
      retryable: false,
      status: 401,
      suggestedAction: "Run densio auth login.",
      title: "Authentication required",
    });

    expect(toProblemDetails(problem, "correlation-1")).toEqual({
      code: "AUTH_REQUIRED",
      correlationId: "correlation-1",
      detail: "Authenticate before submitting a job.",
      details: { command: "densio auth login" },
      retryable: false,
      schemaVersion: 1,
      status: 401,
      suggestedAction: "Run densio auth login.",
      title: "Authentication required",
      type: "about:blank",
    });
  });

  it("does not disclose unexpected error details", () => {
    expect(JSON.stringify(unexpectedProblem(new Error("database password")))).not.toContain(
      "database password",
    );
  });

  it("uses one descriptor for stable runtime and documentation fields", () => {
    const descriptor = defineProblem({
      code: "AUTH_REQUIRED",
      description: "A valid bearer token is required.",
      status: 401,
      title: "Authentication required",
    });

    expect(
      makeDescriptorProblem(descriptor, {
        detail: "Authenticate before submitting a job.",
        retryable: false,
        suggestedAction: "Run densio auth login.",
      }),
    ).toMatchObject({ code: "AUTH_REQUIRED", status: 401, title: "Authentication required" });
    expect(descriptor.description).toBe("A valid bearer token is required.");
  });

  it("returns a payment-required problem when monthly credits are exhausted", () => {
    expect(
      executionPlanProblem(
        new ExecutionPlanCreditsUnavailable({ availableCredits: 0, requiredCredits: 1 }),
      ),
    ).toMatchObject({
      code: "CREDITS_EXHAUSTED",
      retryable: false,
      status: 402,
    });
  });
});
