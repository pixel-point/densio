import { onTestFinished } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ExecutionPlanCreateRequestSchema,
  SourceInspectionSchema,
  type ExecutionPlanSource,
} from "@densio/shared";
import { Effect, Schema } from "effect";
import { PLAN_ENTITLEMENTS } from "../src/auth/entitlements.ts";
import { creditsFromUnits } from "../src/billing/credit-units.ts";
import { migrateDatabase, openDatabase, type Database } from "../src/database/database.ts";
import { createJob } from "../src/database/job-repository.ts";
import { transitionJob } from "../src/database/job-transition-repository.ts";
import {
  artifacts,
  executionPlans,
  jobs,
  preparedSources,
  stripeCustomers,
  stripeSubscriptions,
} from "../src/database/schema.ts";
import { buildExecutionPlan } from "../src/execution-plans/execution-plan-resolver.ts";
import { canonicalDigest } from "../src/idempotency/canonical-digest.ts";
import { ensureOrganizationActor } from "./organization-fixture-identity.ts";

const fixtures: Array<{ readonly database: Database; readonly directory: string }> = [];
export const sourceBytes = Buffer.from("trusted source bytes");
export const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
export const sourceInspection = {
  durationSeconds: 10,
  encodedDimensions: { width: 640, height: 360 },
  displayDimensions: { width: 640, height: 360 },
  rotationDegrees: 0,
  frameRate: { numerator: 30, denominator: 1, framesPerSecond: 30 },
  primaryVideoStream: { index: 0, type: "video", codec: "h264", width: 640, height: 360 },
  audioStreams: [],
  streams: [{ index: 0, type: "video", codec: "h264" }],
} as const;

export const createJobTestContext = async () => {
  const directory = await mkdtemp(join(tmpdir(), "densio-canonical-job-"));
  const database = openDatabase(join(directory, "database.sqlite"));
  const fixture = { database, directory };
  fixtures.push(fixture);
  onTestFinished(async () => {
    const index = fixtures.indexOf(fixture);
    if (index < 0) return;
    fixtures.splice(index, 1);
    database.close();
    await rm(directory, { recursive: true, force: true });
  });
  migrateDatabase(database);
  return { database, directory, mediaRoot: join(directory, "media") };
};

export const cleanupJobFixtures = async () => {
  await Promise.all(
    fixtures.splice(0).map(async ({ database, directory }) => {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }),
  );
};

// Seed genuine source/plan foreign keys; repository tests can then exercise crash states directly.
export const seedJobInput = (
  database: Database,
  overrides: Partial<typeof jobs.$inferInsert> = {},
  resolvedFrameTimestamps: ReadonlyArray<number> = [],
): typeof jobs.$inferInsert => {
  const identity = {
    id: overrides.id ?? "job-1",
    organizationId: overrides.organizationId ?? "org-1",
    createdByUserId: overrides.createdByUserId ?? "user-1",
    sourceId: overrides.sourceId ?? `source-${overrides.id ?? "job-1"}`,
    executionPlanId: overrides.executionPlanId ?? `plan-${overrides.id ?? "job-1"}`,
  };
  const inspection = Schema.decodeUnknownSync(Schema.fromJsonString(SourceInspectionSchema))(
    overrides.inspectionJson ?? JSON.stringify(sourceInspection),
  );
  const source = {
    sourceId: identity.sourceId,
    filename: overrides.sourceFilename ?? "input.mp4",
    declaredBytes: overrides.declaredBytes ?? sourceBytes.byteLength,
    verifiedBytes: overrides.inputBytes ?? sourceBytes.byteLength,
    sha256: overrides.inputSha256 ?? sourceSha256,
    inspection,
  };
  const request = Schema.decodeUnknownSync(ExecutionPlanCreateRequestSchema)({
    sourceId: source.sourceId,
    workflow: overrides.kind ?? "compress",
    options: JSON.parse(
      overrides.requestedOptionsJson ?? '{"codecs":["vp9"],"frameRate":{"mode":"preserve"}}',
    ),
  });
  const snapshot = Effect.runSync(
    buildExecutionPlan({
      organizationId: identity.organizationId,
      createdByUserId: identity.createdByUserId,
      availableCredits: 30,
      resolvedFrameTimestamps,
      ...(overrides.resolvedOptionsJson === undefined
        ? {}
        : { resolvedTrim: JSON.parse(overrides.resolvedOptionsJson).trim }),
      entitlements: PLAN_ENTITLEMENTS[overrides.subscriptionPlan ?? "free"],
      request,
      source,
      toolchain: { ffmpegVersion: "7.1.1", ffprobeVersion: "7.1.1" },
    }),
  );
  if (snapshot.state !== "ready") throw new Error("The job fixture requires a ready plan");
  const createdAt = overrides.createdAt ?? 1;
  seedPlanDependencies(
    database,
    {
      id: identity.executionPlanId,
      organizationId: identity.organizationId,
      createdByUserId: identity.createdByUserId,
      sourceId: identity.sourceId,
      snapshotJson: JSON.stringify({
        ...snapshot,
        quote: {
          ...snapshot.quote,
          creditUnits: overrides.quoteCreditUnits ?? snapshot.quote.creditUnits,
          credits: creditsFromUnits(overrides.quoteCreditUnits ?? snapshot.quote.creditUnits),
        },
      }),
      requestDigest: canonicalDigest(request),
      createdAt,
      expiresAt: 9_000_000_000_000,
    },
    source,
  );
  return {
    ...identity,
    state: "preparing",
    kind: request.workflow,
    subscriptionPlan: "free",
    sourceFilename: source.filename,
    declaredBytes: source.declaredBytes,
    inputBytes: source.verifiedBytes,
    inputSha256: source.sha256,
    requestedOptionsJson: JSON.stringify(snapshot.requestedOptions),
    resolvedOptionsJson: JSON.stringify(snapshot.resolvedOptions),
    inspectionJson: JSON.stringify(inspection),
    intentDigest: snapshot.intentDigest,
    requestDigest: canonicalDigest({
      operation: "plans.execute",
      planId: identity.executionPlanId,
      request: {},
    }),
    quoteCreditUnits: snapshot.quote.creditUnits,
    idempotencyKey: `execute-${identity.id}`,
    progressJson: JSON.stringify({ phase: "preparing", percent: 0, attempt: 0, revision: 0 }),
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
};

export const seedCanonicalJob = (
  database: Database,
  overrides: Partial<typeof jobs.$inferInsert> = {},
  resolvedFrameTimestamps: ReadonlyArray<number> = [],
) => {
  const values = seedJobInput(database, overrides, resolvedFrameTimestamps);
  if (overrides.subscriptionPlan !== undefined && overrides.subscriptionPlan !== "free")
    seedFixtureBillingPlan(
      database,
      values.organizationId,
      overrides.subscriptionPlan,
      values.createdAt,
    );
  const created = createJob(database, values, {
    actor: ensureOrganizationActor(database, values.organizationId, values.createdByUserId),
    now: values.createdAt,
    priceIds: { basic: "price_basic", pro: "price_pro", scale: "price_scale" },
  });
  if ("kind" in created) throw new Error(`Fixture creation failed: ${created.kind}`);
  return created.job;
};

export const queueCanonicalJob = (
  database: Database,
  overrides: Partial<typeof jobs.$inferInsert> = {},
  resolvedFrameTimestamps: ReadonlyArray<number> = [],
) => {
  const job = seedCanonicalJob(database, overrides, resolvedFrameTimestamps);
  const queued = transitionJob(database, {
    jobId: job.id,
    now: job.createdAt + 1,
    command: { type: "source-attached" },
  });
  if (queued === undefined) throw new Error("Fixture could not be queued");
  return queued;
};

export const succeedCanonicalJob = (
  database: Database,
  outputs: ReadonlyArray<typeof artifacts.$inferInsert>,
  overrides: Partial<typeof jobs.$inferInsert> = {},
) => {
  if (outputs.length === 0) throw new Error("Successful fixture jobs need artifact evidence");
  const job = queueCanonicalJob(database, overrides);
  const fence = { workerId: "fixture-worker", attempt: 1 };
  transitionJob(database, {
    jobId: job.id,
    now: job.createdAt + 2,
    command: { type: "claim", workerId: fence.workerId, leaseDurationMs: 10_000 },
  });
  transitionJob(database, {
    jobId: job.id,
    now: job.createdAt + 3,
    command: {
      type: "processing",
      ...fence,
      creditUnits: job.quoteCreditUnits,
      leaseDurationMs: 10_000,
    },
  });
  transitionJob(database, {
    jobId: job.id,
    now: job.createdAt + 4,
    command: { type: "publishing", ...fence },
  });
  database.db
    .insert(artifacts)
    .values([...outputs])
    .run();
  const succeeded = transitionJob(database, {
    jobId: job.id,
    now: job.createdAt + 5,
    command: {
      type: "complete",
      ...fence,
      resultJson: JSON.stringify({
        kind: "compress",
        artifactIds: outputs.map(({ id }) => id),
        html: "<video></video>",
      }),
    },
  });
  if (succeeded === undefined) throw new Error("Fixture job did not complete");
  return succeeded;
};

const seedPlanDependencies = (
  database: Database,
  values: typeof executionPlans.$inferInsert,
  source: ExecutionPlanSource,
) => {
  const createdAt = values.createdAt;
  ensureOrganizationActor(database, values.organizationId, values.createdByUserId);
  database.db
    .insert(preparedSources)
    .values({
      id: values.sourceId,
      organizationId: values.organizationId,
      createdByUserId: values.createdByUserId,
      state: "ready",
      sourceFilename: source.filename,
      declaredBytes: source.declaredBytes,
      inputBytes: source.verifiedBytes,
      inputSha256: source.sha256,
      inspectionJson: JSON.stringify(source.inspection),
      maxUploadBytes: 1_000_000,
      requestDigest: canonicalDigest({ source }),
      createdAt,
      updatedAt: createdAt,
      expiresAt: 9_000_000_000_000,
      uploadExpiresAt: 9_000_000_000_000,
    })
    .onConflictDoNothing()
    .run();

  database.db.insert(executionPlans).values(values).onConflictDoNothing().run();
};

const seedFixtureBillingPlan = (
  database: Database,
  organizationId: string,
  plan: "basic" | "pro" | "scale",
  now: number,
) => {
  const customerId = `fixture-customer-${organizationId}`;
  database.db
    .insert(stripeCustomers)
    .values({ organizationId, customerId, createdAt: now })
    .onConflictDoNothing()
    .run();
  database.db
    .insert(stripeSubscriptions)
    .values({
      organizationId,
      customerId,
      subscriptionId: `fixture-subscription-${organizationId}`,
      priceId: `price_${plan}`,
      status: "active",
      cancelAtPeriodEnd: false,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: stripeSubscriptions.subscriptionId,
      set: { priceId: `price_${plan}`, status: "active", updatedAt: now },
    })
    .run();
};
