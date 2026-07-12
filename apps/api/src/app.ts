import { Hono, type MiddlewareHandler } from "hono";

import { createArtifactRoutes, type ArtifactRouteDependencies } from "./routes/artifacts.ts";
import { createAuthRoutes, type AuthRouteDependencies } from "./routes/auth.ts";
import { createBillingRoutes, type BillingRouteDependencies } from "./routes/billing.ts";
import {
  createCapabilitiesRoutes,
  type CapabilityRouteDependencies,
} from "./routes/capabilities.ts";
import { createHealthRoutes } from "./routes/health.ts";
import { createMediaJobRoutes, type MediaJobRouteDependencies } from "./routes/media-jobs.ts";
import { pageRoutes } from "./routes/pages.ts";

export interface AppDependencies {
  readonly artifacts: ArtifactRouteDependencies;
  readonly auth: AuthRouteDependencies;
  readonly billing: BillingRouteDependencies;
  readonly capabilities: CapabilityRouteDependencies;
  readonly mediaJobs: MediaJobRouteDependencies;
  readonly readiness: Parameters<typeof createHealthRoutes>[0];
}

export const createApp = (dependencies?: AppDependencies) => {
  const app = new Hono();
  app.use("*", async (context, next) => {
    await next();
    context.header("referrer-policy", "no-referrer");
    context.header(
      "content-security-policy",
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    context.header("x-content-type-options", "nosniff");
    context.header("x-frame-options", "DENY");
  });
  app.route("/", createHealthRoutes(dependencies?.readiness));
  app.use("/billing*", noStore);
  app.route("/", pageRoutes);

  if (dependencies !== undefined) {
    app.use("/v1/auth/*", noStore);
    app.use("/v1/billing/*", noStore);
    app.use("/v1/jobs/*", noStore);
    app.route("/", createAuthRoutes(dependencies.auth));
    app.route("/", createBillingRoutes(dependencies.billing));
    app.route("/", createMediaJobRoutes(dependencies.mediaJobs));
    app.route("/", createArtifactRoutes(dependencies.artifacts));
    app.route("/", createCapabilitiesRoutes(dependencies.capabilities));
  }

  return app;
};

const noStore: MiddlewareHandler = async (context, next) => {
  await next();
  context.header("cache-control", "no-store");
};

export type App = ReturnType<typeof createApp>;
