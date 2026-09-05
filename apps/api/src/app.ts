import { createStorageRoutes, type StorageRouteDependencies } from "./routes/video-storage.ts";
import { Hono, type MiddlewareHandler } from "hono";

import { createArtifactRoutes, type ArtifactRouteDependencies } from "./routes/artifacts.ts";
import {
  createArtifactControlRoutes,
  type ArtifactControlRouteDependencies,
} from "./routes/artifact-control.ts";
import { createAuthRoutes, type AuthRouteDependencies } from "./routes/auth.ts";
import { createBillingRoutes, type BillingRouteDependencies } from "./routes/billing.ts";
import {
  createCapabilitiesRoutes,
  type CapabilityRouteDependencies,
} from "./routes/capabilities.ts";
import { registerDocumentationRoutes } from "./routes/documentation.ts";
import { createHealthRoutes } from "./routes/health.ts";
import { createMediaJobRoutes, type MediaJobRouteDependencies } from "./routes/media-jobs.ts";
import {
  createExecutionPlanRoutes,
  type ExecutionPlanRouteDependencies,
} from "./routes/execution-plans.ts";
import { pageRoutes } from "./routes/pages.ts";
import { createSkillRoutes, type SkillRouteDependencies } from "./routes/skill.ts";
import { createSourceRoutes, type SourceRouteDependencies } from "./routes/sources.ts";
import { createOrganizationRoutes } from "./routes/organizations.ts";
import {
  createOrganizationDeletionRoutes,
  type OrganizationDeletionRouteDependencies,
} from "./routes/organization-deletion.ts";
import {
  createOrganizationInvitationRoutes,
  type OrganizationInvitationRouteDependencies,
} from "./routes/organization-invitations.ts";

export interface AppDependencies {
  readonly storage?: StorageRouteDependencies;
  readonly organizationDeletion: OrganizationDeletionRouteDependencies;
  readonly organizations: OrganizationInvitationRouteDependencies;
  readonly artifacts: ArtifactRouteDependencies;
  readonly artifactControl: ArtifactControlRouteDependencies;
  readonly auth: AuthRouteDependencies;
  readonly billing: BillingRouteDependencies;
  readonly capabilities: CapabilityRouteDependencies;
  readonly mediaJobs: MediaJobRouteDependencies;
  readonly executionPlans: ExecutionPlanRouteDependencies;
  readonly readiness: Parameters<typeof createHealthRoutes>[0];
  readonly skill: SkillRouteDependencies;
  readonly sources: SourceRouteDependencies;
}

export const createApp = (dependencies?: AppDependencies) => {
  const app = new Hono();
  app.use("*", async (context, next) => {
    await next();
    context.header("referrer-policy", "no-referrer");
    if (!context.res.headers.has("content-security-policy")) {
      context.header(
        "content-security-policy",
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
    }
    context.header("x-content-type-options", "nosniff");
    context.header("x-frame-options", "DENY");
  });
  app.route("/", createHealthRoutes(dependencies?.readiness));
  app.use("/billing*", noStore);
  app.route("/", pageRoutes);

  if (dependencies !== undefined) {
    app.use("/v1/auth/*", noStore);
    app.use("/v1/organizations*", noStore);
    app.use("/v1/organization-invitations*", noStore);
    if (dependencies.storage) app.route("/", createStorageRoutes(dependencies.storage));
    app.route("/", createOrganizationRoutes(dependencies.organizations));
    app.route("/", createOrganizationDeletionRoutes(dependencies.organizationDeletion));
    app.route("/", createOrganizationInvitationRoutes(dependencies.organizations));
    app.use("/v1/billing/*", noStore);
    app.route("/", createAuthRoutes(dependencies.auth));
    app.route("/", createBillingRoutes(dependencies.billing));
    app.route("/", createMediaJobRoutes(dependencies.mediaJobs));
    app.route("/", createExecutionPlanRoutes(dependencies.executionPlans));
    app.route("/", createSourceRoutes(dependencies.sources));
    app.route("/", createArtifactRoutes(dependencies.artifacts));
    app.route("/", createArtifactControlRoutes(dependencies.artifactControl));
    app.route("/", createCapabilitiesRoutes(dependencies.capabilities));
    app.route("/", createSkillRoutes(dependencies.skill));
  }

  registerDocumentationRoutes(app);

  return app;
};

const noStore: MiddlewareHandler = async (context, next) => {
  await next();
  context.header("cache-control", "no-store");
};

export type App = ReturnType<typeof createApp>;
