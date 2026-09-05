import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PreparedSourceCreateResponseSchema,
  PreparedSourceDeletionReceiptSchema,
  PreparedSourceStatusSchema,
  ProblemDetailsSchema,
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
import { type Database, migrateDatabase, openDatabase } from "../src/database/database.ts";
import { sessions, users } from "../src/database/schema.ts";
import { MediaInspector } from "../src/media/inspection/media-inspector.ts";
import { createSourceRoutes } from "../src/routes/sources.ts";
import { makePreparedSourceService } from "../src/sources/prepared-source-service.ts";

const NOW = 1_800_000_000_000;
const decodeCreated = Schema.decodeUnknownSync(successEnvelope(PreparedSourceCreateResponseSchema));
const decodeStatus = Schema.decodeUnknownSync(successEnvelope(PreparedSourceStatusSchema));
const decodeDeleted = Schema.decodeUnknownSync(
  successEnvelope(PreparedSourceDeletionReceiptSchema),
);
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

it("authenticates, validates, and idempotently creates prepared sources", async () => {
  const harness = await createHarness();
  const ownerToken = seedAccess(harness.database, "owner", "owner@example.com");
  const request = { bytes: 5, filename: "input.mp4" };

  const unauthenticated = await postSource(harness.app, request);
  expect(unauthenticated.status).toBe(401);
  const invalid = await postSource(harness.app, { bytes: 5, filename: "../input.mp4" }, ownerToken);
  expect(invalid.status).toBe(400);

  const firstResponse = await postSource(harness.app, request, ownerToken, "source-request-1");
  const replayResponse = await postSource(harness.app, request, ownerToken, "source-request-1");
  expect(firstResponse.status).toBe(201);
  expect(replayResponse.status).toBe(200);
  const first = decodeCreated(await firstResponse.json());
  const replay = decodeCreated(await replayResponse.json());
  expect(first.data).toMatchObject({ replayed: false, source: { state: "awaiting-upload" } });
  expect(replay.data).toMatchObject({
    replayed: true,
    source: { sourceId: first.data.source.sourceId },
  });

  const conflict = await postSource(
    harness.app,
    { bytes: 6, filename: "other.mp4" },
    ownerToken,
    "source-request-1",
  );
  expect(conflict.status).toBe(409);
  expect(decodeProblem(await conflict.json()).code).toBe("SOURCE_IDEMPOTENCY_CONFLICT");
});

it("uploads, inspects, owner-isolates, reads, and deletes prepared sources", async () => {
  const harness = await createHarness();
  const ownerToken = seedAccess(harness.database, "owner", "owner@example.com");
  const otherToken = seedAccess(harness.database, "other", "other@example.com");
  const createdResponse = await postSource(
    harness.app,
    { bytes: 5, filename: "input.mp4" },
    ownerToken,
  );
  const created = decodeCreated(await createdResponse.json()).data;
  const sourceId = created.source.sourceId;

  const hiddenUpload = await harness.app.request(
    `/v1/organizations/org-1/sources/${sourceId}/upload`,
    {
      body: "hello",
      headers: { authorization: `Bearer ${otherToken}` },
      method: "PUT",
    },
  );
  expect(hiddenUpload.status).toBe(404);

  const upload = await harness.app.request(`/v1/organizations/org-1/sources/${sourceId}/upload`, {
    body: "hello",
    headers: { authorization: `Bearer ${ownerToken}` },
    method: "PUT",
  });
  expect(upload.status).toBe(200);
  expect(decodeStatus(await upload.json()).data).toMatchObject({
    state: "ready",
    verifiedBytes: 5,
  });

  const status = await harness.app.request(`/v1/organizations/org-1/sources/${sourceId}`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  expect(decodeStatus(await status.json()).data).toMatchObject({ state: "ready", sourceId });

  const deleted = await harness.app.request(`/v1/organizations/org-1/sources/${sourceId}`, {
    headers: { authorization: `Bearer ${ownerToken}` },
    method: "DELETE",
  });
  expect(deleted.status).toBe(200);
  expect(decodeDeleted(await deleted.json()).data).toMatchObject({ sourceId, state: "deleted" });
  const expired = await harness.app.request(`/v1/organizations/org-1/sources/${sourceId}`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  expect(decodeStatus(await expired.json()).data.state).toBe("deleted");
});

it("maps upload size and declared-limit failures to public source problems", async () => {
  const harness = await createHarness();
  const token = seedAccess(harness.database, "owner", "owner@example.com");
  const tooLarge = await postSource(harness.app, { bytes: 1_001, filename: "large.mp4" }, token);
  expect(tooLarge.status).toBe(413);
  expect(decodeProblem(await tooLarge.json()).code).toBe("SOURCE_UPLOAD_TOO_LARGE");

  const created = decodeCreated(
    await (await postSource(harness.app, { bytes: 5, filename: "input.mp4" }, token)).json(),
  ).data;
  const mismatch = await harness.app.request(
    `/v1/organizations/org-1/sources/${created.source.sourceId}/upload`,
    {
      body: "four",
      headers: { authorization: `Bearer ${token}` },
      method: "PUT",
    },
  );
  expect(mismatch.status).toBe(400);
  expect(decodeProblem(await mismatch.json()).code).toBe("SOURCE_UPLOAD_SIZE_MISMATCH");
});

const createHarness = async () => {
  const directory = await mkdtemp(join(tmpdir(), "densio-source-routes-"));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, "database.sqlite"));
  databases.push(database);
  migrateDatabase(database);
  const authService = makeAuthService(database, makeMagicLinkSealer("0123456789abcdef".repeat(4)));
  const billingService = makeBillingService(database, unusedStripeGateway);
  const sourceService = makePreparedSourceService(database, {
    now: () => NOW,
    inspector,
    mediaRoot: join(directory, "media"),
    publicBaseUrl: "https://media.example",
    sourceTtlMs: 120_000,
    uploadTtlMs: 30_000,
  });
  const app = new Hono();
  app.route(
    "/",
    createSourceRoutes({
      organizationService: makeOrganizationService(database),
      authService,
      billingService,
      createCorrelationId: () => "source-route-correlation",
      maxUploadBytes: 1_000,
      now: () => NOW,
      priceIds: { basic: "price_basic", pro: "price_pro", scale: "price_scale" },
      sourceService,
    }),
  );
  return { app, database };
};

const inspector = MediaInspector.of({
  checkCapabilities: () => Effect.die("Not expected"),
  classifyAudio: () => Effect.die("Not expected"),
  resolveTrimRange: () => Effect.die("Unexpected trim resolution"),
  resolveFrameTimestamp: () => Effect.die("Not expected"),
  inspect: () =>
    Effect.succeed({
      audioStreamIndexes: [],
      displayDimensions: { height: 360, width: 640 },
      durationSeconds: 2,
      encodedDimensions: { height: 360, width: 640 },
      frameRate: { denominator: 1, framesPerSecond: 30, numerator: 30 },
      rotationDegrees: 0,
      streams: [{ codecName: "h264", index: 0, type: "video" }],
      videoStreamIndex: 0,
    }),
});

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

const postSource = (app: Hono, body: unknown, token?: string, idempotencyKey?: string) =>
  app.request("/v1/organizations/org-1/sources", {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
    },
    method: "POST",
  });
