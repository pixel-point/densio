import { Effect, Result, Schema } from "effect";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";

import { getHealthStatus } from "../services/health.ts";
import { jsonResponse } from "./openapi-support.ts";

const HealthResponseSchema = Schema.Struct({ status: Schema.Literal("ok") });
const ReadyResponseSchema = Schema.Struct({
  ffmpegVersion: Schema.String,
  ffprobeVersion: Schema.String,
  status: Schema.Literal("ready"),
});
const NotReadyResponseSchema = Schema.Struct({ status: Schema.Literal("not-ready") });
const healthDocumentation = describeRoute({
  operationId: "getHealth",
  responses: { "200": jsonResponse("The process is healthy.", HealthResponseSchema) },
  summary: "Check process health",
  tags: ["System"],
});
const readinessDocumentation = describeRoute({
  operationId: "getReadiness",
  responses: {
    "200": jsonResponse("The API and media tools are ready.", ReadyResponseSchema),
    "503": jsonResponse("A required dependency is not ready.", NotReadyResponseSchema),
  },
  summary: "Check service readiness",
  tags: ["System"],
});

type ReadinessCheck = () => Effect.Effect<
  {
    readonly ffmpegVersion: string;
    readonly ffprobeVersion: string;
    readonly status: "ready";
  },
  unknown
>;

export const createHealthRoutes = (readiness?: ReadinessCheck) => {
  const routes = new Hono();
  routes.get("/health", healthDocumentation, async (context) =>
    context.json(await Effect.runPromise(getHealthStatus())),
  );
  if (readiness !== undefined) {
    routes.get("/ready", readinessDocumentation, async (context) => {
      const result = await Effect.runPromise(Effect.result(readiness()));
      return Result.isSuccess(result)
        ? context.json(result.success)
        : context.json({ status: "not-ready" as const }, 503);
    });
  }
  return routes;
};

export const healthRoutes = createHealthRoutes();
