import { Effect, Result } from "effect";
import { Hono } from "hono";

import { getHealthStatus } from "../services/health.ts";

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
  routes.get("/health", async (context) =>
    context.json(await Effect.runPromise(getHealthStatus())),
  );
  if (readiness !== undefined) {
    routes.get("/ready", async (context) => {
      const result = await Effect.runPromise(Effect.result(readiness()));
      return Result.isSuccess(result)
        ? context.json(result.success)
        : context.json({ status: "not-ready" as const }, 503);
    });
  }
  return routes;
};

export const healthRoutes = createHealthRoutes();
