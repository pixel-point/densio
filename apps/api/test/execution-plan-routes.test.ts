import { TrimRangeInvalid, TrimTimelineUnsupported } from "../src/media/inspection/trim-errors.ts";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ExecutionPlanCreateResponseSchema,
  ExecutionPlanExecuteResponseSchema,
  ExecutionPlanStatusSchema,
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
import { migrateDatabase, openDatabase, type Database } from "../src/database/database.ts";
import {
  executionPlans,
  jobCreditEntries,
  jobs,
  preparedSources,
  sessions,
  users,
} from "../src/database/schema.ts";
import { makeExecutionPlanService } from "../src/execution-plans/execution-plan-service.ts";
import { createExecutionPlanRoutes } from "../src/routes/execution-plans.ts";

const NOW = 1_800_000_000_000;
const temporaryDirectories: Array<string> = [];
const databases: Array<Database> = [];
const decodeCreated = Schema.decodeUnknownSync(successEnvelope(ExecutionPlanCreateResponseSchema));
const decodeStatus = Schema.decodeUnknownSync(successEnvelope(ExecutionPlanStatusSchema));
const decodeExecuted = Schema.decodeUnknownSync(
  successEnvelope(ExecutionPlanExecuteResponseSchema),
);

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

it.each([
  { workflow: "hls" },
  {
    workflow: "trim",
    options: {
      trim: { start: { kind: "frame", frame: 30 }, end: { kind: "frame", frame: 60 } },
      output: { codec: "vp9" },
    },
  },
  { workflow: "compress", options: { codecs: ["h265"] } },
  { workflow: "compress", options: { codecs: ["h265"], bitDepth: 10 } },
  { workflow: "extract-images" },
  {
    workflow: "compare-quality",
    options: {
      bitDepth: 10,
      variants: [
        { codec: "h265", crf: 28 },
        { codec: "h265", crf: 30 },
      ],
    },
  },
])(
  "submits $workflow directly and recovers the accepted job after source expiry",
  async (intent) => {
    const harness = await createHarness();
    const request = { sourceId: "source-1", ...intent, clientReference: "direct-demo" };
    const submit = (body: unknown = request) =>
      harness.app.request("/v1/organizations/org-1/jobs", {
        method: "POST",
        headers: authHeaders(harness.token, { "idempotency-key": "direct-1" }),
        body: JSON.stringify(body),
      });
    const first = await submit();
    expect(first.status).toBe(201);
    expect(decodeExecuted(await first.json()).data).toMatchObject({
      jobId: "job-1",
      state: "queued",
      replayed: false,
    });
    harness.database.db.update(preparedSources).set({ state: "expired" }).run();
    const replay = await submit();
    expect(replay.status).toBe(200);
    expect(decodeExecuted(await replay.json()).data).toMatchObject({
      jobId: "job-1",
      replayed: true,
    });
    expect((await submit({ ...request, clientReference: "changed" })).status).toBe(409);
    expect(harness.database.db.select().from(jobs).all()).toHaveLength(1);
    expect(harness.database.db.select().from(executionPlans).all()).toHaveLength(1);
    if (intent.options && "bitDepth" in intent.options) {
      const job = harness.database.db.select().from(jobs).get();
      expect(JSON.parse(job?.resolvedOptionsJson ?? "null")).toMatchObject({ bitDepth: 10 });
      expect(
        (await submit({ ...request, options: { ...intent.options, bitDepth: 8 } })).status,
      ).toBe(409);
    }
    expect(harness.database.db.select().from(jobCreditEntries).all()).toMatchObject([
      { kind: "hold" },
    ]);
  },
);

it.each(["compress", "compare-quality"])(
  "rejects unsupported bit depth for %s before admission",
  async (workflow) => {
    const harness = await createHarness();
    const options = {
      bitDepth: 12,
      ...(workflow === "compare-quality"
        ? {
            variants: [
              { codec: "vp9", crf: 30 },
              { codec: "vp9", crf: 40 },
            ],
          }
        : {}),
    };
    for (const path of ["jobs", "execution-plans"]) {
      const response = await harness.app.request(`/v1/organizations/org-1/${path}`, {
        method: "POST",
        headers: authHeaders(harness.token, { "idempotency-key": `invalid-${path}` }),
        body: JSON.stringify({ sourceId: "source-1", workflow, options }),
      });
      expect(response.status).toBe(400);
    }
    expect(harness.database.db.select().from(jobs).all()).toHaveLength(0);
    expect(harness.database.db.select().from(executionPlans).all()).toHaveLength(0);
    expect(harness.database.db.select().from(jobCreditEntries).all()).toHaveLength(0);
  },
);

it("rejects direct submission decisions and spending guards without persisting work", async () => {
  const harness = await createHarness();
  const submit = (options: unknown, constraints?: unknown, key = "direct-decision") =>
    harness.app.request("/v1/organizations/org-1/jobs", {
      method: "POST",
      headers: authHeaders(harness.token, { "idempotency-key": key }),
      body: JSON.stringify({ sourceId: "source-1", workflow: "compress", options, constraints }),
    });
  harness.database.db
    .update(preparedSources)
    .set({
      inspectionJson: JSON.stringify({
        ...inspection,
        frameRate: { numerator: 60, denominator: 1, framesPerSecond: 60 },
      }),
    })
    .run();
  const decision = await submit({ codecs: ["h265"] });
  expect(decision.status).toBe(409);
  expect(await decision.json()).toMatchObject({
    code: "MEDIA_DECISION_REQUIRED",
    details: {
      sourceId: "source-1",
      decision: { kind: "frame-rate", recommended: { mode: "cap", maximum: 30 } },
    },
  });
  const guarded = await submit(
    { codecs: ["h265"], frameRate: { mode: "preserve" } },
    { maxCredits: 0.01 },
  );
  expect(guarded.status).toBe(412);
  expect(harness.database.db.select().from(jobs).all()).toHaveLength(0);
  expect(harness.database.db.select().from(executionPlans).all()).toHaveLength(0);
  expect(harness.database.db.select().from(jobCreditEntries).all()).toHaveLength(0);
  expect((await submit({ codecs: ["h265"], frameRate: { mode: "preserve" } })).status).toBe(201);
});

it("concurrent direct HLS requests converge on one snapshot, job, and credit hold", async () => {
  const harness = await createHarness();
  const responses = await Promise.all(
    Array.from({ length: 8 }, () =>
      harness.app.request("/v1/organizations/org-1/jobs", {
        method: "POST",
        headers: authHeaders(harness.token, { "idempotency-key": "concurrent-hls" }),
        body: JSON.stringify({ sourceId: "source-1", workflow: "hls" }),
      }),
    ),
  );
  expect(responses.map(({ status }) => status).toSorted()).toEqual([
    200, 200, 200, 200, 200, 200, 200, 201,
  ]);
  const accepted = await Promise.all(
    responses.map(async (response) => decodeExecuted(await response.json()).data.jobId),
  );
  expect(new Set(accepted).size).toBe(1);
  expect(harness.database.db.select().from(jobs).all()).toHaveLength(1);
  expect(harness.database.db.select().from(executionPlans).all()).toHaveLength(1);
  expect(harness.database.db.select().from(jobCreditEntries).all()).toMatchObject([
    { kind: "hold" },
  ]);
});

it("creates, reads, executes, and safely replays an owned immutable plan", async () => {
  const harness = await createHarness();
  const missingKey = await harness.app.request("/v1/organizations/org-1/execution-plans", {
    body: JSON.stringify({ sourceId: "source-1", workflow: "compress", options: {} }),
    headers: authHeaders(harness.token),
    method: "POST",
  });
  expect(missingKey.status).toBe(201);
  expect(decodeCreated(await missingKey.json()).data).toMatchObject({
    replayed: false,
    plan: { planId: "plan-1" },
  });

  const request = {
    sourceId: "source-1",
    workflow: "compress",
    options: { codecs: ["vp9"], frameRate: { mode: "preserve" } },
    constraints: { maxOutputBytes: 5_000_000 },
  };
  const firstResponse = await harness.app.request("/v1/organizations/org-1/execution-plans", {
    body: JSON.stringify(request),
    headers: authHeaders(harness.token, { "idempotency-key": "plan/create-1" }),
    method: "POST",
  });
  const first = decodeCreated(await firstResponse.json());
  const replayResponse = await harness.app.request("/v1/organizations/org-1/execution-plans", {
    body: JSON.stringify(request),
    headers: authHeaders(harness.token, { "idempotency-key": "plan/create-1" }),
    method: "POST",
  });
  const replay = decodeCreated(await replayResponse.json());

  expect(firstResponse.status).toBe(201);
  expect(first.data).toMatchObject({ replayed: false, plan: { planId: "plan-2", state: "ready" } });
  expect(replayResponse.status).toBe(200);
  expect(replay.data).toMatchObject({ replayed: true, plan: { planId: "plan-2" } });

  const statusResponse = await harness.app.request(
    `/v1/organizations/org-1/execution-plans/${first.data.plan.planId}`,
    {
      headers: authHeaders(harness.token),
    },
  );
  expect(statusResponse.status).toBe(200);
  expect(decodeStatus(await statusResponse.json()).data).toMatchObject({
    planId: "plan-2",
    state: "ready",
  });

  const executeBody = {
    clientReference: "release/launch",
    maxCredits: 1,
    maxOutputBytes: 4_000_000,
  };
  const executeWithoutKey = await harness.app.request(
    `/v1/organizations/org-1/execution-plans/${first.data.plan.planId}/execute`,
    {
      body: JSON.stringify(executeBody),
      headers: authHeaders(harness.token),
      method: "POST",
    },
  );
  expect(executeWithoutKey.status).toBe(400);
  const executeResponse = await harness.app.request(
    `/v1/organizations/org-1/execution-plans/${first.data.plan.planId}/execute`,
    {
      body: JSON.stringify(executeBody),
      headers: authHeaders(harness.token, { "idempotency-key": "plan/execute-1" }),
      method: "POST",
    },
  );
  const executed = decodeExecuted(await executeResponse.json());
  const executeReplay = await harness.app.request(
    `/v1/organizations/org-1/execution-plans/${first.data.plan.planId}/execute`,
    {
      body: JSON.stringify(executeBody),
      headers: authHeaders(harness.token, { "idempotency-key": "plan/execute-1" }),
      method: "POST",
    },
  );

  expect(executeResponse.status).toBe(201);
  expect(executed.data).toMatchObject({ replayed: false, jobId: "job-1", state: "queued" });
  expect(executeReplay.status).toBe(200);
  expect(decodeExecuted(await executeReplay.json()).data).toMatchObject({
    replayed: true,
    jobId: "job-1",
  });
});

const createHarness = async () => {
  const directory = await mkdtemp(join(tmpdir(), "densio-execution-plan-routes-"));
  temporaryDirectories.push(directory);
  const database = openDatabase(join(directory, "database.sqlite"));
  databases.push(database);
  migrateDatabase(database);
  const mediaRoot = join(directory, "media");
  const token = seedAccess(database);
  ensureOrganizationActor(database);
  const bytes = Buffer.from("trusted prepared source");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  database.db
    .insert(preparedSources)
    .values({
      id: "source-1",
      requestDigest: "a".repeat(64),
      organizationId: "org-1",
      createdByUserId: "user-1",
      state: "ready",
      sourceFilename: "launch.mp4",
      declaredBytes: bytes.byteLength,
      maxUploadBytes: 1_000,
      inputBytes: bytes.byteLength,
      inputSha256: sha256,
      inspectionJson: JSON.stringify(inspection),
      uploadExpiresAt: NOW + 60_000,
      expiresAt: NOW + 120_000,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  const sourceInput = join(mediaRoot, "sources", "source-1", "input", "source-video");
  await mkdir(join(mediaRoot, "sources", "source-1", "input"), { recursive: true });
  await writeFile(sourceInput, bytes);
  let planId = 0;
  let jobId = 0;
  const authService = makeAuthService(database, makeMagicLinkSealer("0123456789abcdef".repeat(4)));
  const billingService = makeBillingService(database, unusedStripeGateway);
  const executionPlanService = makeExecutionPlanService(database, {
    now: () => NOW,
    priceIds: { basic: "price_basic", pro: "price_pro", scale: "price_scale" },
    createId: () => `plan-${++planId}`,
    createJobId: () => `job-${++jobId}`,
    maxExtractedImages: 2_000,
    mediaRoot,
    planTtlMs: 60_000,
    publicBaseUrl: "https://media.example",
    resolveTrimRange: (_sourceId, range) =>
      range.start.kind === "frame" && range.start.frame === 999
        ? Effect.fail(new TrimRangeInvalid({ message: "Frame is outside the source." }))
        : range.start.kind === "frame" && range.start.frame === 998
          ? Effect.fail(new TrimTimelineUnsupported({ message: "Missing frame timestamps." }))
          : Effect.succeed({
              videoStreamIndex: 0,
              startFrame: 30,
              endFrame: 60,
              frameCount: 30,
              startPts: "1000",
              endPts: "2000",
              timeBase: { numerator: 1, denominator: 1000 },
              durationSeconds: 1,
            }),
    resolveFrameTimestamp: (_sourceId, frame) => Effect.succeed(frame / 30),
    toolchain: { ffmpegVersion: "7.1.1", ffprobeVersion: "7.1.1" },
  });
  const app = new Hono();
  app.route(
    "/",
    createExecutionPlanRoutes({
      organizationService: makeOrganizationService(database),
      authService,
      billingService,
      createCorrelationId: () => "plan-route-correlation",
      executionPlanService,
      now: () => NOW,
      priceIds: { basic: "price_basic", pro: "price_pro", scale: "price_scale" },
    }),
  );
  return { app, token, database };
};

const seedAccess = (database: Database) => {
  database.db
    .insert(users)
    .values({ createdAt: NOW, email: "one@example.com", id: "user-1", updatedAt: NOW })
    .run();
  const access = createOpaqueToken();
  database.db
    .insert(sessions)
    .values({
      accessExpiresAt: NOW + 60_000,
      accessTokenHash: hashTokenSecret(access.secret),
      createdAt: NOW,
      familyId: "family-user-1",
      id: access.publicId,
      refreshExpiresAt: NOW + 120_000,
      updatedAt: NOW,
      userId: "user-1",
    })
    .run();
  return formatOpaqueToken(access);
};

const authHeaders = (token: string, extra: Readonly<Record<string, string>> = {}) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  ...extra,
});

const inspection = {
  videoProperties: {
    pixelFormat: "yuv420p",
    fieldOrder: "progressive",
    sampleAspectRatio: { numerator: 1, denominator: 1 },
  },
  durationSeconds: 30,
  encodedDimensions: { width: 1_920, height: 1_080 },
  displayDimensions: { width: 1_920, height: 1_080 },
  rotationDegrees: 0,
  frameRate: { numerator: 30, denominator: 1, framesPerSecond: 30 },
  primaryVideoStream: { index: 0, type: "video", codec: "h264", width: 1_920, height: 1_080 },
  audioStreams: [{ index: 1, type: "audio", codec: "aac", channels: 2 }],
  streams: [
    { index: 0, type: "video", codec: "h264" },
    { index: 1, type: "audio", codec: "aac" },
  ],
};

it.each(["jobs", "execution-plans"])(
  "rejects invalid ranges and unsupported timing before %s admission",
  async (endpoint) => {
    const harness = await createHarness();
    for (const [frame, status, code] of [
      [999, 400, "INVALID_REQUEST"],
      [998, 422, "TRIM_TIMELINE_UNSUPPORTED"],
    ] as const) {
      const response = await harness.app.request(`/v1/organizations/org-1/${endpoint}`, {
        method: "POST",
        headers: authHeaders(harness.token, { "idempotency-key": "bad-trim" }),
        body: JSON.stringify({
          sourceId: "source-1",
          workflow: "trim",
          options: { trim: { start: { kind: "frame", frame } }, output: { codec: "vp9" } },
        }),
      });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code });
    }
    expect(harness.database.db.select().from(jobs).all()).toHaveLength(0);
    expect(harness.database.db.select().from(jobCreditEntries).all()).toHaveLength(0);
  },
);

it("previews standalone trimming with the same resolved settings and quote as direct submission", async () => {
  const harness = await createHarness();
  const body = JSON.stringify({
    sourceId: "source-1",
    workflow: "trim",
    options: {
      trim: { start: { kind: "frame", frame: 30 }, end: { kind: "frame", frame: 60 } },
      output: { codec: "vp9" },
    },
  });
  const preview = await harness.app.request("/v1/organizations/org-1/execution-plans", {
    method: "POST",
    headers: authHeaders(harness.token),
    body,
  });
  expect(preview.status).toBe(201);
  const plan = decodeCreated(await preview.json()).data.plan;
  expect(plan).toMatchObject({
    workflow: "trim",
    state: "ready",
    quote: { credits: 0.05 },
    expectedArtifacts: [{ durationSeconds: 1 }],
  });
  expect(harness.database.db.select().from(jobCreditEntries).all()).toHaveLength(0);
  const submitted = await harness.app.request("/v1/organizations/org-1/jobs", {
    method: "POST",
    headers: authHeaders(harness.token, { "idempotency-key": "trim-direct" }),
    body,
  });
  expect(submitted.status).toBe(201);
  const snapshots = harness.database.db
    .select()
    .from(executionPlans)
    .all()
    .map((row) => JSON.parse(row.snapshotJson));
  expect(snapshots[0].resolvedOptions).toEqual(snapshots[1].resolvedOptions);
  expect(snapshots[0].quote).toEqual(snapshots[1].quote);
});
