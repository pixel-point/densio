import { describe, expect, it } from "vitest";

import { makeProblem, toProblemDetails, unexpectedProblem } from "../src/errors/problem-details.ts";

describe("problem details", () => {
  it("creates schema-versioned actionable RFC 9457 responses", () => {
    const problem = makeProblem({
      code: "AUTH_REQUIRED",
      detail: "Authenticate before submitting a job.",
      retryable: false,
      status: 401,
      suggestedAction: "Run ffmpeg-api auth login.",
      title: "Authentication required",
    });

    expect(toProblemDetails(problem, "correlation-1")).toEqual({
      code: "AUTH_REQUIRED",
      correlationId: "correlation-1",
      detail: "Authenticate before submitting a job.",
      retryable: false,
      schemaVersion: 1,
      status: 401,
      suggestedAction: "Run ffmpeg-api auth login.",
      title: "Authentication required",
      type: "about:blank",
    });
  });

  it("does not disclose unexpected error details", () => {
    expect(JSON.stringify(unexpectedProblem(new Error("database password")))).not.toContain(
      "database password",
    );
  });
});
