import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CapabilitiesSchema,
  PublicCapabilitiesSchema,
  JobEventPageSchema,
  JobListResponseSchema,
  JobStatusSchema,
  ProblemDetailsSchema,
  type Plan,
  successEnvelope,
} from "@densio/shared";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { afterEach, expect, it } from "vitest";

import { makeOrganizationService } from "../src/organizations/organization-service.ts";
import { ensureOrganizationActor } from "./organization-fixture-identity.ts";
import { makeAuthService } from "../src/auth/auth-service.ts";
import { makeMagicLinkSealer } from "../src/auth/magic-link-secret.ts";
import { createOpaqueToken, formatOpaqueToken, hashTokenSecret } from "../src/auth/opaque-token.ts";
import { makeBillingService } from "../src/billing/billing-service.ts";
import { unusedStripeGateway } from "./unused-stripe-gateway.ts";
import { buildCapabilities, buildPublicCapabilities } from "../src/capabilities.ts";
import { loadConfig } from "../src/config.ts";
import { type Database, migrateDatabase, openDatabase } from "../src/database/database.ts";
import { sessions, users } from "../src/database/schema.ts";
import { makeJobService } from "../src/jobs/job-service.ts";
import { createArtifactRoutes } from "../src/routes/artifacts.ts";
import { createCapabilitiesRoutes } from "../src/routes/capabilities.ts";
import { createMediaJobRoutes } from "../src/routes/media-jobs.ts";
import { queueCanonicalJob } from "./job-fixture.ts";

const NOW = 1_800_000_000_000;
const decodeStatus = Schema.decodeUnknownSync(successEnvelope(JobStatusSchema));
const decodeProblem = Schema.decodeUnknownSync(ProblemDetailsSchema);
const databases: Array<Database> = [];
const temporaryDirectories: Array<string> = [];
afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("reads and cancels a planned owned job while hiding foreign resources", async () => {
  const harness = await createHarness();
  const owner = seedAccess(harness.database, "owner", "owner@example.com");
  const other = seedAccess(harness.database, "other", "other@example.com");
  queueCanonicalJob(harness.database, {
    organizationId: "org-1",
    createdByUserId: "owner",
    createdAt: NOW - 2,
  });
  const status = await harness.app.request("/v1/organizations/org-1/jobs/job-1", {
    headers: authHeaders(owner),
  });
  expect(status.status).toBe(200);
  expect(status.headers.get("cache-control")).toBe("no-store");
  expect(decodeStatus(await status.json()).data).toMatchObject({
    id: "job-1",
    state: "queued",
    sourceId: "source-job-1",
    executionPlanId: "plan-job-1",
  });
  const hidden = await harness.app.request("/v1/organizations/org-1/jobs/job-1", {
    headers: authHeaders(other),
  });
  expect(hidden.status).toBe(404);
  expect(decodeProblem(await hidden.json()).code).toBe("ORGANIZATION_NOT_FOUND");
  const canceled = await harness.app.request("/v1/organizations/org-1/jobs/job-1/cancel", {
    method: "POST",
    headers: authHeaders(owner),
  });
  expect(canceled.status).toBe(200);
  expect(decodeStatus(await canceled.json()).data).toMatchObject({
    state: "canceled",
    receipt: { execution: { attempts: 0, commands: [] } },
  });
});

it("discovers owner-scoped jobs by filters and recovery keys and pages events", async () => {
  const harness = await createHarness();
  const token = seedAccess(harness.database, "owner", "owner@example.com");
  queueCanonicalJob(harness.database, {
    organizationId: "org-1",
    createdByUserId: "owner",
    clientReference: "launch/hero",
    idempotencyKey: "launch-hero",
    createdAt: NOW - 2,
  });
  queueCanonicalJob(harness.database, {
    id: "foreign",
    organizationId: "org-2",
    createdByUserId: "other",
    createdAt: NOW - 2,
  });
  const listed = await harness.app.request(
    "/v1/organizations/org-1/jobs?state=queued&workflow=compress&limit=1",
    {
      headers: authHeaders(token),
    },
  );
  expect(
    Schema.decodeUnknownSync(successEnvelope(JobListResponseSchema))(await listed.json()).data.jobs,
  ).toMatchObject([{ id: "job-1" }]);
  for (const query of ["clientReference=launch%2Fhero", "idempotencyKey=launch-hero"]) {
    const found = await harness.app.request(`/v1/organizations/org-1/jobs/lookup?${query}`, {
      headers: authHeaders(token),
    });
    expect(decodeStatus(await found.json()).data.id).toBe("job-1");
  }
  const events = await harness.app.request(
    "/v1/organizations/org-1/jobs/job-1/events?after=0&limit=1",
    {
      headers: authHeaders(token),
    },
  );
  const page = Schema.decodeUnknownSync(successEnvelope(JobEventPageSchema))(
    await events.json(),
  ).data;
  expect(page.events).toHaveLength(1);
  const rest = await harness.app.request(
    `/v1/organizations/org-1/jobs/job-1/events?after=${page.nextCursor}`,
    {
      headers: authHeaders(token),
    },
  );
  const later = Schema.decodeUnknownSync(successEnvelope(JobEventPageSchema))(
    await rest.json(),
  ).data;
  expect(later.events.every(({ sequence }) => sequence > page.nextCursor)).toBe(true);
});

it.each([
  "/v1/organizations/org-1/jobs?cursor=malformed",
  "/v1/organizations/org-1/jobs?limit=0",
  "/v1/organizations/org-1/jobs?state=awaiting-upload",
  "/v1/organizations/org-1/jobs?since=not-a-date",
  "/v1/organizations/org-1/jobs/lookup",
  "/v1/organizations/org-1/jobs/lookup?clientReference=a&idempotencyKey=b",
  "/v1/organizations/org-1/jobs/job-1/events?after=-1",
  "/v1/organizations/org-1/jobs/job-1/events?limit=101",
])("rejects invalid query contracts: %s", async (path) => {
  const harness = await createHarness();
  const token = seedAccess(harness.database, "owner", "owner@example.com");
  const response = await harness.app.request(path, { headers: authHeaders(token) });
  expect(response.status).toBe(400);
  expect(decodeProblem(await response.json()).code).toBe("INVALID_REQUEST");
});

it.each([
  ["POST", "/v1/compress"],
  ["POST", "/v1/extract-images"],
  ["POST", "/v1/compare-quality"],
  ["PUT", "/v1/organizations/org-1/jobs/job-1/upload"],
  ["POST", "/v1/organizations/org-1/jobs/job-1/frame-rate-decision"],
])("does not expose removed %s %s routes", async (method, path) => {
  const harness = await createHarness();
  expect((await harness.app.request(path, { method })).status).toBe(404);
});

it("requires authentication for job discovery and status", async () => {
  const harness = await createHarness();
  for (const path of [
    "/v1/organizations/org-1/jobs",
    "/v1/organizations/org-1/jobs/job-1",
    "/v1/organizations/org-1/jobs/job-1/events",
    "/v1/organizations/org-1/jobs/lookup?clientReference=x",
  ]) {
    expect((await harness.app.request(path)).status).toBe(401);
  }
});

it("projects public and authenticated capabilities through the canonical contract", async () => {
  const harness = await createHarness();
  const token = seedAccess(harness.database, "owner", "owner@example.com");
  const publicResponse = await harness.app.request("/v1/capabilities");
  expect(publicResponse.headers.get("cache-control")).toBeNull();
  expect(
    Schema.decodeUnknownSync(successEnvelope(PublicCapabilitiesSchema))(await publicResponse.json())
      .data,
  ).toMatchObject({
    scope: "public",
    controlPlane: { sourceListing: true },
    options: { comparisonSampleCount: { minimum: 1 } },
  });
  await Effect.runPromise(
    harness.billingService.grantPro({ grantedBy: "test-admin", now: NOW, organizationId: "org-1" }),
  );
  const paidResponse = await harness.app.request("/v1/organizations/org-1/capabilities", {
    headers: authHeaders(token),
  });
  expect(
    Schema.decodeUnknownSync(successEnvelope(CapabilitiesSchema))(await paidResponse.json()).data
      .plan,
  ).toBe("pro");
});

interface Harness {
  readonly app: Hono;
  readonly billingService: ReturnType<typeof makeBillingService>;
  readonly database: Database;
  readonly mediaRoot: string;
}

const createHarness = async (): Promise<Harness> => {
  const directory = await mkdtemp(join(tmpdir(), "densio-media-routes-"));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, "database.sqlite"));
  databases.push(database);
  migrateDatabase(database);
  const mediaRoot = join(directory, "media");
  const authService = makeAuthService(database, makeMagicLinkSealer("0123456789abcdef".repeat(4)));
  const billingService = makeBillingService(database, unusedStripeGateway);
  const jobService = makeJobService(database, {
    mediaRoot,
    now: () => NOW,
    publicBaseUrl: "https://media.example",
  });
  const common = {
    organizationService: makeOrganizationService(database),
    authService,
    billingService,
    createCorrelationId: () => "media-route-correlation",
    now: () => NOW,
    priceIds: {
      basic: "price_basic",
      scale: "price_scale",
      pro: "price_pro",
    },
  };
  const app = new Hono();
  app.route("/", createMediaJobRoutes({ ...common, jobService }));
  app.route(
    "/",
    createArtifactRoutes({
      createCorrelationId: common.createCorrelationId,
      database,
      now: common.now,
    }),
  );
  app.route(
    "/",
    createCapabilitiesRoutes({
      ...common,
      capabilitiesForPlan,
      publicCapabilities: buildPublicCapabilities(loadConfig({}), {
        encoders: ["libvpx-vp9", "libx265", "libsvtav1"],
        ffmpegVersion: "7.1-static",
        ffprobeVersion: "7.1-static",
      }),
    }),
  );
  return { app, billingService, database, mediaRoot };
};

const seedAccess = (database: Database, userId: string, email: string) => {
  database.db.insert(users).values({ createdAt: NOW, email, id: userId, updatedAt: NOW }).run();
  ensureOrganizationActor(database, userId === "owner" ? "org-1" : "org-2", userId);
  const access = createOpaqueToken();
  database.db
    .insert(sessions)
    .values({
      accessExpiresAt: NOW + 60_000,
      accessTokenHash: hashTokenSecret(access.secret),
      createdAt: NOW,
      familyId: `family-${userId}`,
      id: access.publicId,
      refreshExpiresAt: NOW + 120_000,
      updatedAt: NOW,
      userId,
    })
    .run();
  return formatOpaqueToken(access);
};

const authHeaders = (token: string) => ({ authorization: `Bearer ${token}` });
const capabilitiesForPlan = (plan: Plan) =>
  buildCapabilities(
    loadConfig({}),
    {
      encoders: ["libvpx-vp9", "libx265", "libsvtav1"],
      ffmpegVersion: "7.1-static",
      ffprobeVersion: "7.1-static",
    },
    plan,
  );
