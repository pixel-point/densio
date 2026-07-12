import { describe, expect, it } from "vitest";

import { exitCodeForProblem, formatJsonSuccess, formatProgress } from "../src/output.ts";

describe("agent-first output", () => {
  it("emits one stable JSON document without progress on stdout", () => {
    expect(
      formatJsonSuccess({
        correlationId: "request-1",
        data: { jobId: "job-1" },
        ok: true,
        schemaVersion: 1,
      }),
    ).toBe('{"ok":true,"schemaVersion":1,"data":{"jobId":"job-1"},"correlationId":"request-1"}\n');
  });

  it("maps stable problem groups to documented exit codes", () => {
    expect(exitCodeForProblem({ code: "AUTH_REQUIRED", status: 401 })).toBe(3);
    expect(exitCodeForProblem({ code: "PLAN_LIMIT_EXCEEDED", status: 403 })).toBe(4);
    expect(exitCodeForProblem({ code: "JOB_FAILED", status: 422 })).toBe(5);
    expect(exitCodeForProblem({ code: "INTERNAL_ERROR", status: 500 })).toBe(5);
  });

  it("keeps human progress concise and newline terminated", () => {
    expect(formatProgress("job-1", "processing", 42)).toBe("job-1 processing 42%\n");
  });
});
