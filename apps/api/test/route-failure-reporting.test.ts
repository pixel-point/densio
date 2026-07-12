import { Effect } from "effect";
import { Hono } from "hono";
import { expect, it } from "vitest";

import { InvalidEmailAddress } from "../src/auth/email-address.ts";
import { JobRepositoryError } from "../src/jobs/job-service.ts";
import { runRouteEffect, type RouteFailureReport } from "../src/routes/route-support.ts";

it("reports one sanitized internal failure with its correlation ID", async () => {
  const reports: Array<RouteFailureReport> = [];
  const app = new Hono();
  app.get("/", (context) =>
    runRouteEffect(
      context,
      "correlation-1",
      Effect.fail(
        new JobRepositoryError({
          cause: new Error("database password must stay secret"),
          operation: "find-status",
        }),
      ),
      () => context.text("unexpected"),
      (report) => {
        reports.push(report);
      },
    ),
  );

  const response = await app.request("/");
  const body = await response.text();

  expect(response.status).toBe(500);
  expect(reports).toEqual([
    {
      correlationId: "correlation-1",
      errorTag: "JobRepositoryError",
      operation: "find-status",
    },
  ]);
  expect(`${body}${JSON.stringify(reports)}`).not.toContain("database password");
});

it("does not report expected client failures", async () => {
  const reports: Array<RouteFailureReport> = [];
  const app = new Hono();
  app.get("/", (context) =>
    runRouteEffect(
      context,
      "correlation-2",
      Effect.fail(new InvalidEmailAddress({ message: "invalid" })),
      () => context.text("unexpected"),
      (report) => {
        reports.push(report);
      },
    ),
  );

  const response = await app.request("/");

  expect(response.status).toBe(400);
  expect(reports).toEqual([]);
});
