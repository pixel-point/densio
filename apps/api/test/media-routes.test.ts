import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CapabilitiesSchema,
  JobCreatedResponseSchema,
  JobStatusSchema,
  ProblemDetailsSchema,
  UploadCompletedResponseSchema,
  type Capabilities,
  successEnvelope,
} from "@ffmpeg-api/shared";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { afterEach, expect, it } from "vitest";

import { makeAuthService } from "../src/auth/auth-service.ts";
import { makeMagicLinkSealer } from "../src/auth/magic-link-secret.ts";
import { createOpaqueToken, formatOpaqueToken, hashTokenSecret } from "../src/auth/opaque-token.ts";
import { makeBillingService } from "../src/billing/billing-service.ts";
import { StripeGateway } from "../src/billing/stripe-gateway.ts";
import { registerArtifact } from "../src/database/artifact-repository.ts";
import { type Database, migrateDatabase, openDatabase } from "../src/database/database.ts";
import { jobs, sessions, users } from "../src/database/schema.ts";
import { makeJobService } from "../src/jobs/job-service.ts";
import { createArtifactRoutes } from "../src/routes/artifacts.ts";
import { createCapabilitiesRoutes } from "../src/routes/capabilities.ts";
import { createMediaJobRoutes } from "../src/routes/media-jobs.ts";

const NOW = 1_800_000_000_000;
const decodeCreated = Schema.decodeUnknownSync(successEnvelope(JobCreatedResponseSchema));
const decodeUploaded = Schema.decodeUnknownSync(successEnvelope(UploadCompletedResponseSchema));
const decodeStatus = Schema.decodeUnknownSync(successEnvelope(JobStatusSchema));
const decodeCapabilities = Schema.decodeUnknownSync(successEnvelope(CapabilitiesSchema));
const decodeProblem = Schema.decodeUnknownSync(ProblemDetailsSchema);

const databases: Array<Database> = [];
const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

it("creates, idempotently retries, uploads, reads, and cancels an owned job", async () => {
  const harness = await createHarness();
  const ownerToken = seedAccess(harness.database, "owner", "owner@example.com");
  const otherToken = seedAccess(harness.database, "other", "other@example.com");
  const request = {
    options: { audio: "remove" },
    source: { bytes: 5, filename: "input.mp4" },
  };

  const firstResponse = await harness.app.request("/v1/compress", {
    body: JSON.stringify(request),
    headers: authHeaders(ownerToken, { "idempotency-key": "agent-request-1" }),
    method: "POST",
  });
  expect(firstResponse.status).toBe(201);
  const first = decodeCreated(await firstResponse.json());
  const retried = decodeCreated(
    await (
      await harness.app.request("/v1/compress", {
        body: JSON.stringify(request),
        headers: authHeaders(ownerToken, {
          "idempotency-key": "agent-request-1",
        }),
        method: "POST",
      })
    ).json(),
  );
  expect(retried.data.jobId).toBe(first.data.jobId);
  expect(harness.database.db.select().from(jobs).all()).toHaveLength(1);

  const uploadResponse = await harness.app.request(`/v1/jobs/${first.data.jobId}/upload`, {
    body: "hello",
    headers: { authorization: `Bearer ${ownerToken}` },
    method: "PUT",
  });
  expect(uploadResponse.status).toBe(200);
  expect(decodeUploaded(await uploadResponse.json()).data).toMatchObject({
    bytes: 5,
    state: "queued",
  });

  const statusResponse = await harness.app.request(`/v1/jobs/${first.data.jobId}`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  expect(decodeStatus(await statusResponse.json()).data).toMatchObject({
    id: first.data.jobId,
    state: "queued",
    workflow: "compress",
  });
  const hidden = await harness.app.request(`/v1/jobs/${first.data.jobId}`, {
    headers: { authorization: `Bearer ${otherToken}` },
  });
  expect(hidden.status).toBe(404);
  expect(decodeProblem(await hidden.json()).code).toBe("JOB_NOT_FOUND");

  const cancelResponse = await harness.app.request(`/v1/jobs/${first.data.jobId}/cancel`, {
    headers: { authorization: `Bearer ${ownerToken}` },
    method: "POST",
  });
  expect(decodeStatus(await cancelResponse.json()).data.state).toBe("canceled");
  await expect(
    stat(join(harness.mediaRoot, "work", first.data.jobId, "input", "source-video")),
  ).rejects.toThrow();
});

it("validates each media request and persists the authenticated Pro plan", async () => {
  const harness = await createHarness();
  const token = seedAccess(harness.database, "owner", "owner@example.com");
  await Effect.runPromise(
    harness.billingService.grantPro({
      grantedBy: "root",
      now: NOW,
      userId: "owner",
    }),
  );

  const extraction = await postJson(harness.app, "/v1/extract-images", token, {
    options: { format: "webp", intervalSeconds: 0.5 },
    source: { bytes: 5, filename: "input.mp4" },
  });
  const comparison = await postJson(harness.app, "/v1/compare-quality", token, {
    options: { codec: "av1", crfs: [30, 40] },
    source: { bytes: 5, filename: "input.mp4" },
  });
  expect(extraction.status).toBe(201);
  expect(comparison.status).toBe(201);
  expect(
    harness.database.db
      .select()
      .from(jobs)
      .all()
      .map(({ kind, plan }) => ({ kind, plan })),
  ).toEqual([
    { kind: "extract-images", plan: "pro" },
    { kind: "compare-quality", plan: "pro" },
  ]);

  const invalid = await postJson(harness.app, "/v1/compare-quality", token, {
    options: { codec: "av1", crfs: [30] },
    source: { bytes: 5, filename: "input.mp4" },
  });
  expect(invalid.status).toBe(400);
  expect(decodeProblem(await invalid.json()).code).toBe("INVALID_REQUEST");
});

it("serves signed artifacts with ETags, safe filenames, and RFC byte ranges", async () => {
  const harness = await createHarness();
  seedAccess(harness.database, "owner", "owner@example.com");
  insertJob(harness.database, "job-artifact", "owner");
  const directory = join(harness.mediaRoot, "job-artifact", "artifacts");
  const path = join(directory, "video.webm");
  const content = "0123456789";
  await mkdir(directory, { recursive: true });
  await writeFile(path, content);
  const registered = await Effect.runPromise(
    registerArtifact(harness.database, {
      expiresAt: NOW + 60_000,
      filename: "video.webm",
      jobId: "job-artifact",
      kind: "video",
      mediaType: "video/webm",
      now: NOW,
      path,
      publicBaseUrl: "https://media.example",
      sha256: createHash("sha256").update(content).digest("hex"),
      sizeBytes: content.length,
    }),
  );
  const artifactPath = new URL(registered.downloadUrl).pathname;

  const full = await harness.app.request(artifactPath);
  expect(full.status).toBe(200);
  expect(await full.text()).toBe(content);
  expect(full.headers.get("accept-ranges")).toBe("bytes");
  expect(full.headers.get("cache-control")).toBe("private, max-age=60, immutable");
  expect(full.headers.get("etag")).toMatch(/^"sha256-[a-f0-9]{64}"$/);

  const partial = await harness.app.request(artifactPath, {
    headers: { range: "bytes=2-5" },
  });
  expect(partial.status).toBe(206);
  expect(await partial.text()).toBe("2345");
  expect(partial.headers.get("content-range")).toBe("bytes 2-5/10");

  const notModified = await harness.app.request(artifactPath, {
    headers: { "if-none-match": full.headers.get("etag") ?? "" },
  });
  expect(notModified.status).toBe(304);
  const wrongFilename = artifactPath.replace("video.webm", "other.webm");
  expect((await harness.app.request(wrongFilename)).status).toBe(404);

  const invalidRange = await harness.app.request(artifactPath, {
    headers: { range: "bytes=20-30" },
  });
  expect(invalidRange.status).toBe(416);
  expect(invalidRange.headers.get("content-range")).toBe("bytes */10");
});

it("returns injected free capabilities publicly and Pro capabilities to an owner", async () => {
  const harness = await createHarness();
  const token = seedAccess(harness.database, "owner", "owner@example.com");
  const publicResponse = await harness.app.request("/v1/capabilities");
  expect(decodeCapabilities(await publicResponse.json()).data.plan).toBe("free");

  await Effect.runPromise(
    harness.billingService.grantPro({
      grantedBy: "root",
      now: NOW,
      userId: "owner",
    }),
  );
  const proResponse = await harness.app.request("/v1/capabilities", {
    headers: { authorization: `Bearer ${token}` },
  });
  const capabilities = decodeCapabilities(await proResponse.json()).data;
  expect(capabilities.plan).toBe("pro");
  expect(capabilities.codecs.find(({ codec }) => codec === "av1")).toMatchObject({
    minimumPlan: "pro",
  });
});

interface Harness {
  readonly app: Hono;
  readonly billingService: ReturnType<typeof makeBillingService>;
  readonly database: Database;
  readonly mediaRoot: string;
}

const createHarness = async (): Promise<Harness> => {
  const directory = await mkdtemp(join(tmpdir(), "ffmpeg-api-media-routes-"));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, "database.sqlite"));
  databases.push(database);
  migrateDatabase(database);
  const mediaRoot = join(directory, "media");
  const authService = makeAuthService(database, makeMagicLinkSealer("0123456789abcdef".repeat(4)));
  const billingService = makeBillingService(database, unusedStripeGateway);
  const jobService = makeJobService(database, {
    maxUploadBytes: 1_000,
    mediaRoot,
    publicBaseUrl: "https://media.example",
    uploadTtlMs: 60_000,
  });
  const common = {
    authService,
    billingService,
    createCorrelationId: () => "media-route-correlation",
    now: () => NOW,
    proPriceId: "price_pro",
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
    }),
  );
  return { app, billingService, database, mediaRoot };
};

const unusedStripeGateway = StripeGateway.of({
  createCheckoutSession: Effect.fn("MediaRoutes.unusedCheckout")(() =>
    Effect.die("Stripe Checkout was not expected"),
  ),
  createPortalSession: Effect.fn("MediaRoutes.unusedPortal")(() =>
    Effect.die("Stripe Portal was not expected"),
  ),
  parseWebhook: Effect.fn("MediaRoutes.unusedWebhook")(() =>
    Effect.die("Stripe webhook parsing was not expected"),
  ),
});

const seedAccess = (database: Database, userId: string, email: string) => {
  database.db.insert(users).values({ createdAt: NOW, email, id: userId, updatedAt: NOW }).run();
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

const authHeaders = (token: string, extra: Readonly<Record<string, string>> = {}) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  ...extra,
});

const postJson = (app: Hono, path: string, token: string, body: unknown) =>
  app.request(path, {
    body: JSON.stringify(body),
    headers: authHeaders(token),
    method: "POST",
  });

const insertJob = (database: Database, id: string, userId: string) => {
  database.db
    .insert(jobs)
    .values({
      createdAt: NOW,
      declaredBytes: 10,
      id,
      kind: "compress",
      optionsJson: "{}",
      plan: "free",
      sourceFilename: "input.mp4",
      state: "succeeded",
      updatedAt: NOW,
      userId,
    })
    .run();
};

const capabilitiesForPlan = (plan: "free" | "pro"): Capabilities => ({
  apiVersion: "v1",
  codecs: [
    {
      codec: "vp9",
      container: "webm",
      crfRange: { maximum: 63, minimum: 0 },
      defaultCrf: 40,
      minimumPlan: "free",
    },
    {
      codec: "h265",
      container: "mp4",
      crfRange: { maximum: 51, minimum: 0 },
      defaultCrf: 32,
      minimumPlan: "free",
    },
    {
      codec: "av1",
      container: "webm",
      crfRange: { maximum: 63, minimum: 0 },
      defaultCrf: 35,
      minimumPlan: "pro",
    },
  ],
  defaults: {
    audio: "auto",
    comparisonDurationSeconds: 1,
    comparisonPositionSeconds: 0,
    compressionCodecs: ["vp9", "h265"],
    extractionFormat: "jpeg",
    extractionIntervalSeconds: 1,
  },
  limits: {
    artifactRetentionSeconds: 86_400,
    maxComparisonCrfs: 8,
    maxComparisonDurationSeconds: 3,
    maxExtractionImages: 2_000,
    maxUploadBytes: 1_000,
    maxVideoDurationSeconds: plan === "pro" ? 1_800 : 10,
  },
  options: {
    audioModes: ["auto", "keep", "remove"],
    comparisonCrfCount: { maximum: 8, minimum: 2 },
    comparisonDurationSeconds: { default: 1, maximum: 3, minimum: 1 },
    comparisonPositionKinds: ["seconds", "timecode", "frame"],
    cropKinds: ["aspect-ratio", "rectangle"],
    imageFormats: ["jpeg", "png", "webp"],
    scaleDimensions: ["width", "height"],
  },
  plan,
  server: {
    ffmpegVersion: "7.1-static",
    ffprobeVersion: "7.1-static",
    maxConcurrentMediaProcesses: 3,
  },
  workflows: ["compress", "extract-images", "compare-quality"],
});
