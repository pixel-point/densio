import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";

import { PLAN_ENTITLEMENTS } from "../src/auth/entitlements.ts";
import { migrateDatabase, openDatabase, type Database } from "../src/database/database.ts";
import { jobCreditEntries, jobs, preparedSources } from "../src/database/schema.ts";
import {
  ExecutionPlanDecisionRequired,
  ExecutionPlanExpired,
  ExecutionPlanIdempotencyConflict,
  ExecutionPlanNotFound,
  ExecutionPlanSourceUnavailable,
} from "../src/execution-plans/execution-plan-errors.ts";
import { cancelOrganizationJob } from "../src/database/job-transition-repository.ts";
import {
  ensureOrganizationActor,
  fixtureOrganizationActor,
  otherFixtureOrganizationActor,
} from "./organization-fixture-identity.ts";
import { makeExecutionPlanService } from "../src/execution-plans/execution-plan-service.ts";

const temporaryDirectories: Array<string> = [];
let database: Database;
let nextId = 0;
let mediaRoot: string;

beforeEach(async () => {
  const directory = await mkdtemp(join(tmpdir(), "densio-execution-plan-service-"));
  temporaryDirectories.push(directory);
  database = openDatabase(join(directory, "database.sqlite"));
  mediaRoot = join(directory, "media");
  migrateDatabase(database);
  ensureOrganizationActor(database);
  ensureOrganizationActor(database, "org-2", "user-2");
  database.db
    .insert(preparedSources)
    .values({
      id: "source-1",
      organizationId: "org-1",
      createdByUserId: "user-1",
      state: "ready",
      sourceFilename: "launch.mp4",
      requestDigest: "d".repeat(64),
      declaredBytes: 2_048,
      maxUploadBytes: 10_000,
      inputBytes: 2_048,
      inputSha256: "a".repeat(64),
      inspectionJson: JSON.stringify(inspection()),
      uploadExpiresAt: 2_000,
      expiresAt: 100_000,
      createdAt: 1,
      updatedAt: 2,
    })
    .run();
  nextId = 0;
});

afterEach(async () => {
  database.close();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

it("creates and replays the same immutable intent while rejecting key reuse", async () => {
  const service = makeService();
  const input = {
    availableCredits: 30,
    entitlements: PLAN_ENTITLEMENTS.free,
    idempotencyKey: "plan/create-1",
    now: 10_000,
    request: {
      sourceId: "source-1",
      workflow: "compress" as const,
      options: { codecs: ["vp9" as const], frameRate: { mode: "preserve" as const } },
    },
    ...fixtureOrganizationActor,
  };

  const first = await Effect.runPromise(service.create(input));
  const replay = await Effect.runPromise(service.create(input));
  const conflict = await Effect.runPromise(
    Effect.flip(
      service.create({
        ...input,
        request: { ...input.request, options: { codecs: ["h265"] } },
      }),
    ),
  );

  expect(first).toMatchObject({ replayed: false, plan: { planId: "plan-1", state: "ready" } });
  expect(replay).toMatchObject({ replayed: true, plan: { planId: "plan-1" } });
  expect(conflict).toBeInstanceOf(ExecutionPlanIdempotencyConflict);
});

it("replays a due immutable plan as expired without an execute action", async () => {
  const service = makeService();
  const input = {
    availableCredits: 30,
    entitlements: PLAN_ENTITLEMENTS.free,
    idempotencyKey: "plan/replay-after-expiry",
    now: 10_000,
    request: { sourceId: "source-1", workflow: "extract-images" as const, options: {} },
    ...fixtureOrganizationActor,
  };
  const created = await Effect.runPromise(service.create(input));

  const replay = await Effect.runPromise(service.create({ ...input, now: 20_000 }));

  expect(replay).toMatchObject({
    replayed: true,
    plan: { planId: created.plan.planId, state: "ready", availability: "expired" },
  });
  expect(replay.plan).not.toHaveProperty("execute");
});

it("does not replay a create key for a different prepared-source handle", async () => {
  database.db
    .insert(preparedSources)
    .values({
      id: "source-2",
      organizationId: "org-1",
      createdByUserId: "user-1",
      state: "ready",
      sourceFilename: "launch.mp4",
      requestDigest: "d".repeat(64),
      declaredBytes: 2_048,
      maxUploadBytes: 10_000,
      inputBytes: 2_048,
      inputSha256: "a".repeat(64),
      inspectionJson: JSON.stringify(inspection()),
      uploadExpiresAt: 2_000,
      expiresAt: 100_000,
      createdAt: 1,
      updatedAt: 2,
    })
    .run();
  const service = makeService();
  const input = {
    availableCredits: 30,
    entitlements: PLAN_ENTITLEMENTS.free,
    idempotencyKey: "plan/same-content-source",
    now: 10_000,
    request: {
      sourceId: "source-1",
      workflow: "extract-images" as const,
      options: {},
    },
    ...fixtureOrganizationActor,
  };

  await Effect.runPromise(service.create(input));
  const conflict = await Effect.runPromise(
    Effect.flip(service.create({ ...input, request: { ...input.request, sourceId: "source-2" } })),
  );

  expect(conflict).toBeInstanceOf(ExecutionPlanIdempotencyConflict);
});

it("replays a create after the addressed source changes state", async () => {
  const service = makeService();
  const input = {
    availableCredits: 30,
    entitlements: PLAN_ENTITLEMENTS.free,
    idempotencyKey: "plan/replay-expired-source",
    now: 10_000,
    request: {
      sourceId: "source-1",
      workflow: "extract-images" as const,
      options: {},
    },
    ...fixtureOrganizationActor,
  };
  const created = await Effect.runPromise(service.create(input));
  database.db.update(preparedSources).set({ state: "expired" }).run();

  await expect(Effect.runPromise(service.create({ ...input, now: 10_100 }))).resolves.toMatchObject(
    { replayed: true, plan: { planId: created.plan.planId } },
  );
});

it("returns owned plans and converts expired snapshots to a non-executable state", async () => {
  const service = makeService();
  const created = await Effect.runPromise(
    service.create({
      availableCredits: 30,
      entitlements: PLAN_ENTITLEMENTS.free,
      idempotencyKey: "plan/create-1",
      now: 10_000,
      request: { sourceId: "source-1", workflow: "extract-images", options: {} },
      ...fixtureOrganizationActor,
    }),
  );
  const status = await Effect.runPromise(
    service.get({ now: 10_500, planId: created.plan.planId, ...fixtureOrganizationActor }),
  );
  const expired = await Effect.runPromise(
    service.get({ now: 20_001, planId: created.plan.planId, ...fixtureOrganizationActor }),
  );
  const foreign = await Effect.runPromise(
    Effect.flip(
      service.get({ now: 10_500, planId: created.plan.planId, ...otherFixtureOrganizationActor }),
    ),
  );

  expect(status.state).toBe("ready");
  expect(expired).toMatchObject({
    state: "ready",
    availability: "expired",
    planId: created.plan.planId,
  });
  expect(expired).not.toHaveProperty("execute");
  expect(foreign).toBeInstanceOf(ExecutionPlanNotFound);
});

it("caps plan lifetime at the prepared-source retention deadline", async () => {
  database.db.update(preparedSources).set({ expiresAt: 15_000 }).run();
  const service = makeService();
  const created = await Effect.runPromise(
    service.create({
      availableCredits: 30,
      entitlements: PLAN_ENTITLEMENTS.free,
      idempotencyKey: "plan/create-source-bound",
      now: 10_000,
      request: { sourceId: "source-1", workflow: "extract-images", options: {} },
      ...fixtureOrganizationActor,
    }),
  );

  expect(created.plan.expiresAt).toBe(new Date(15_000).toISOString());
  await expect(
    Effect.runPromise(
      service.get({ now: 15_000, planId: created.plan.planId, ...fixtureOrganizationActor }),
    ),
  ).resolves.toMatchObject({ state: "ready", availability: "expired" });
});

it("resolves a high-frame-rate decision into a new superseding ready plan", async () => {
  database.db
    .update(preparedSources)
    .set({ inspectionJson: JSON.stringify(inspection(60)) })
    .run();
  const service = makeService();
  const created = await Effect.runPromise(
    service.create({
      availableCredits: 30,
      entitlements: PLAN_ENTITLEMENTS.free,
      idempotencyKey: "plan/create-1",
      now: 10_000,
      request: { sourceId: "source-1", workflow: "compress", options: { codecs: ["vp9"] } },
      ...fixtureOrganizationActor,
    }),
  );
  const resolved = await Effect.runPromise(
    service.resolve({
      availableCredits: 30,
      entitlements: PLAN_ENTITLEMENTS.free,
      frameRate: { maximum: 30, mode: "cap" },
      idempotencyKey: "plan/resolve-1",
      now: 10_100,
      planId: created.plan.planId,
      ...fixtureOrganizationActor,
    }),
  );

  expect(created.plan.state).toBe("decision-required");
  expect(resolved).toMatchObject({
    replayed: false,
    plan: {
      state: "ready",
      planId: "plan-2",
      supersedesPlanId: "plan-1",
      resolvedOptions: { frameRate: { maximum: 30, mode: "cap" } },
    },
  });
});

it("binds a resolve idempotency key to its exact parent and replays after parent expiry", async () => {
  database.db
    .update(preparedSources)
    .set({ inspectionJson: JSON.stringify(inspection(60)) })
    .run();
  const service = makeService();
  const createInput = {
    availableCredits: 30,
    entitlements: PLAN_ENTITLEMENTS.free,
    now: 10_000,
    request: {
      sourceId: "source-1",
      workflow: "compress" as const,
      options: { codecs: ["vp9" as const] },
    },
    ...fixtureOrganizationActor,
  };
  const firstParent = await Effect.runPromise(service.create(createInput));
  const secondParent = await Effect.runPromise(service.create(createInput));
  const resolveInput = {
    availableCredits: 30,
    entitlements: PLAN_ENTITLEMENTS.free,
    frameRate: { maximum: 30 as const, mode: "cap" as const },
    idempotencyKey: "plan/resolve-exact-parent",
    now: 10_100,
    planId: firstParent.plan.planId,
    ...fixtureOrganizationActor,
  };
  const child = await Effect.runPromise(service.resolve(resolveInput));
  database.sqlite
    .prepare("update execution_plans set expires_at = 10101 where id = ?")
    .run(firstParent.plan.planId);

  await expect(
    Effect.runPromise(service.resolve({ ...resolveInput, now: 10_200 })),
  ).resolves.toMatchObject({ replayed: true, plan: { planId: child.plan.planId } });
  await expect(
    Effect.runPromise(
      Effect.flip(
        service.resolve({
          ...resolveInput,
          now: 10_200,
          planId: secondParent.plan.planId,
        }),
      ),
    ),
  ).resolves.toBeInstanceOf(ExecutionPlanIdempotencyConflict);
});

it("replays a due resolved child as expired without an execute action", async () => {
  database.db
    .update(preparedSources)
    .set({ inspectionJson: JSON.stringify(inspection(60)) })
    .run();
  const service = makeService();
  const parent = await Effect.runPromise(
    service.create({
      availableCredits: 30,
      entitlements: PLAN_ENTITLEMENTS.free,
      now: 10_000,
      request: {
        sourceId: "source-1",
        workflow: "compress",
        options: { codecs: ["vp9"] },
      },
      ...fixtureOrganizationActor,
    }),
  );
  const input = {
    availableCredits: 30,
    entitlements: PLAN_ENTITLEMENTS.free,
    frameRate: { maximum: 30 as const, mode: "cap" as const },
    idempotencyKey: "plan/resolve-after-expiry",
    now: 10_100,
    planId: parent.plan.planId,
    ...fixtureOrganizationActor,
  };
  const child = await Effect.runPromise(service.resolve(input));

  const replay = await Effect.runPromise(service.resolve({ ...input, now: 20_100 }));

  expect(replay).toMatchObject({
    replayed: true,
    plan: { planId: child.plan.planId, state: "ready", availability: "expired" },
  });
  expect(replay.plan).not.toHaveProperty("execute");
});

it("resolves frame-index comparison samples against the trusted prepared source", async () => {
  const service = makeService();
  const created = await Effect.runPromise(
    service.create({
      availableCredits: 30,
      entitlements: PLAN_ENTITLEMENTS.free,
      idempotencyKey: "plan/create-frame-samples",
      now: 10_000,
      request: {
        sourceId: "source-1",
        workflow: "compare-quality",
        options: {
          variants: [
            { codec: "vp9", crf: 36 },
            { codec: "h265", crf: 30 },
          ],
          objectiveMetrics: ["ssim"],
          samples: {
            mode: "positions",
            positions: [
              { kind: "seconds", seconds: 1 },
              { kind: "frame", frame: 99 },
            ],
          },
        },
      },
      ...fixtureOrganizationActor,
    }),
  );

  expect(created.plan).toMatchObject({
    state: "ready",
    requestedOptions: {
      samples: { mode: "positions", positions: [expect.anything(), { kind: "frame", frame: 99 }] },
    },
    resolvedOptions: {
      samples: [
        {
          sampleId: "sample-1",
          normalizedStartSeconds: 1,
          actualSampleDurationSeconds: 1,
        },
        {
          sampleId: "sample-2",
          normalizedStartSeconds: 29.5,
          actualSampleDurationSeconds: 0.5,
        },
      ],
    },
  });
});

it("executes a ready plan once, attaches the trusted source, and replays current job state", async () => {
  const bytes = Buffer.from("trusted prepared source");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const sourceInput = join(mediaRoot, "sources", "source-1", "input", "source-video");
  await mkdir(join(mediaRoot, "sources", "source-1", "input"), { recursive: true });
  await writeFile(sourceInput, bytes);
  database.db
    .update(preparedSources)
    .set({ declaredBytes: bytes.byteLength, inputBytes: bytes.byteLength, inputSha256: sha256 })
    .run();
  const service = makeService();
  const created = await Effect.runPromise(
    service.create({
      availableCredits: 30,
      entitlements: PLAN_ENTITLEMENTS.free,
      idempotencyKey: "plan/create-1",
      now: 10_000,
      request: {
        sourceId: "source-1",
        workflow: "compress",
        options: { codecs: ["vp9"], frameRate: { mode: "preserve" } },
        constraints: { maxOutputBytes: 5_000_000 },
      },
      ...fixtureOrganizationActor,
    }),
  );
  const executionInput = {
    availableCredits: 30,
    clientReference: "release/launch",
    entitlements: PLAN_ENTITLEMENTS.free,
    idempotencyKey: "plan/execute-1",
    maxCredits: 1,
    maxOutputBytes: 4_000_000,
    now: 10_100,
    planId: created.plan.planId,
    ...fixtureOrganizationActor,
  };
  const executed = await Effect.runPromise(service.execute(executionInput));
  const row = database.db.select().from(jobs).where(eq(jobs.id, executed.jobId)).get();
  const hold = database.db
    .select()
    .from(jobCreditEntries)
    .where(eq(jobCreditEntries.jobId, executed.jobId))
    .get();

  expect(executed).toEqual({
    organizationId: "org-1",
    replayed: false,
    jobId: "job-1",
    state: "queued",
    statusUrl: "https://api.densio.test/v1/organizations/org-1/jobs/job-1",
  });
  expect(row).toMatchObject({
    sourceId: "source-1",
    executionPlanId: created.plan.planId,
    clientReference: "release/launch",
    maxOutputBytes: 4_000_000,
    inputBytes: bytes.byteLength,
    inputSha256: sha256,
    state: "queued",
  });
  expect(hold).toMatchObject({ kind: "hold", units: row?.quoteCreditUnits });

  cancelOrganizationJob(database, {
    jobId: "job-1",
    actor: fixtureOrganizationActor,
    now: 10_150,
  });
  await expect(
    Effect.runPromise(
      service.execute({
        ...executionInput,
        now: 10_200,
      }),
    ),
  ).resolves.toMatchObject({ replayed: true, jobId: "job-1", state: "canceled" });

  await expect(
    Effect.runPromise(
      Effect.flip(
        service.execute({
          ...executionInput,
          maxCredits: 2,
          now: 10_300,
        }),
      ),
    ),
  ).resolves.toBeInstanceOf(ExecutionPlanIdempotencyConflict);
});

it("makes irrecoverable attachment failure terminal, releases the quote, and never resurrects it on replay", async () => {
  const service = makeService();
  const created = await Effect.runPromise(
    service.create({
      availableCredits: 30,
      entitlements: PLAN_ENTITLEMENTS.free,
      now: 10_000,
      request: { sourceId: "source-1", workflow: "extract-images", options: {} },
      ...fixtureOrganizationActor,
    }),
  );
  const input = {
    availableCredits: 30,
    entitlements: PLAN_ENTITLEMENTS.free,
    idempotencyKey: "execute-missing-bytes",
    now: 10_100,
    planId: created.plan.planId,
    ...fixtureOrganizationActor,
  };
  expect(await Effect.runPromise(service.execute(input))).toMatchObject({
    jobId: "job-1",
    state: "failed",
    replayed: false,
  });
  const job = database.db.select().from(jobs).get();
  expect(job).toMatchObject({
    sourceId: "source-1",
    state: "failed",
    attemptCount: 0,
    errorCode: "PREPARED_SOURCE_UNAVAILABLE",
  });
  const receipt = JSON.parse(job?.receiptJson ?? "{}");
  expect(receipt.execution).toMatchObject({ attempts: 0, commands: [] });
  expect(receipt.execution).not.toHaveProperty("startedAt");
  expect(receipt.execution).not.toHaveProperty("ffmpegVersion");
  expect(database.db.select().from(jobCreditEntries).all()).toMatchObject([
    { kind: "hold", units: job?.quoteCreditUnits },
    { kind: "release", units: job?.quoteCreditUnits },
  ]);
  expect(await Effect.runPromise(service.execute({ ...input, now: 10_200 }))).toMatchObject({
    jobId: "job-1",
    state: "failed",
    replayed: true,
  });
});

it("projects expired availability without rewriting immutable intent or adding policy labels", async () => {
  const service = makeService();
  const created = await Effect.runPromise(
    service.create({
      availableCredits: 30,
      entitlements: PLAN_ENTITLEMENTS.free,
      now: 10_000,
      request: { sourceId: "source-1", workflow: "extract-images", options: {} },
      ...fixtureOrganizationActor,
    }),
  );
  const before = database.sqlite
    .prepare("select * from execution_plans where id = ?")
    .get(created.plan.planId);
  const expired = await Effect.runPromise(
    service.get({ now: 20_000, planId: created.plan.planId, ...fixtureOrganizationActor }),
  );
  expect(expired).toMatchObject({ availability: "expired", state: "ready" });
  expect(expired).not.toHaveProperty("execute");
  expect(expired).not.toHaveProperty("policyVersion");
  expect(expired).not.toHaveProperty("profileVersion");
  expect(
    database.sqlite.prepare("select * from execution_plans where id = ?").get(created.plan.planId),
  ).toEqual(before);
});

it("reports typed decision-required and expired plan failures", async () => {
  database.db
    .update(preparedSources)
    .set({ inspectionJson: JSON.stringify(inspection(60)) })
    .run();
  const service = makeService();
  const decision = await Effect.runPromise(
    service.create({
      availableCredits: 30,
      entitlements: PLAN_ENTITLEMENTS.free,
      now: 10_000,
      request: {
        sourceId: "source-1",
        workflow: "compress",
        options: { codecs: ["vp9"] },
      },
      ...fixtureOrganizationActor,
    }),
  );
  const executeError = await Effect.runPromise(
    Effect.flip(
      service.execute({
        availableCredits: 30,
        entitlements: PLAN_ENTITLEMENTS.free,
        idempotencyKey: "plan/execute-needs-decision",
        now: 10_100,
        planId: decision.plan.planId,
        ...fixtureOrganizationActor,
      }),
    ),
  );
  await Effect.runPromise(
    service.get({ now: 20_001, planId: decision.plan.planId, ...fixtureOrganizationActor }),
  );
  const [executeExpired, resolveExpired] = await Effect.runPromise(
    Effect.all([
      Effect.flip(
        service.execute({
          availableCredits: 30,
          entitlements: PLAN_ENTITLEMENTS.free,
          idempotencyKey: "plan/execute-expired",
          now: 20_002,
          planId: decision.plan.planId,
          ...fixtureOrganizationActor,
        }),
      ),
      Effect.flip(
        service.resolve({
          availableCredits: 30,
          entitlements: PLAN_ENTITLEMENTS.free,
          frameRate: { maximum: 30, mode: "cap" },
          now: 20_002,
          planId: decision.plan.planId,
          ...fixtureOrganizationActor,
        }),
      ),
    ]),
  );

  expect(executeError).toBeInstanceOf(ExecutionPlanDecisionRequired);
  expect(executeExpired).toBeInstanceOf(ExecutionPlanExpired);
  expect(resolveExpired).toBeInstanceOf(ExecutionPlanExpired);
});

it("rejects execution after the prepared source is explicitly expired", async () => {
  const service = makeService();
  const created = await Effect.runPromise(
    service.create({
      availableCredits: 30,
      entitlements: PLAN_ENTITLEMENTS.free,
      idempotencyKey: "plan/create-source-race",
      now: 10_000,
      request: { sourceId: "source-1", workflow: "extract-images", options: {} },
      ...fixtureOrganizationActor,
    }),
  );
  database.db.update(preparedSources).set({ state: "expired" }).run();

  await expect(
    Effect.runPromise(
      Effect.flip(
        service.execute({
          availableCredits: 30,
          entitlements: PLAN_ENTITLEMENTS.free,
          idempotencyKey: "plan/execute-source-race",
          now: 10_100,
          planId: created.plan.planId,
          ...fixtureOrganizationActor,
        }),
      ),
    ),
  ).resolves.toBeInstanceOf(ExecutionPlanSourceUnavailable);
  expect(database.db.select().from(jobs).all()).toEqual([]);
});
const makeService = () =>
  makeExecutionPlanService(database, {
    now: () => 10_000,
    priceIds: { basic: "price_basic", pro: "price_pro", scale: "price_scale" },
    createId: () => `plan-${++nextId}`,
    createJobId: () => "job-1",
    maxExtractedImages: 2_000,
    mediaRoot,
    planTtlMs: 10_000,
    publicBaseUrl: "https://api.densio.test",
    resolveFrameTimestamp: (_sourceId, frame) => Effect.succeed(frame === 99 ? 29.5 : 1.25),
    toolchain: { ffmpegVersion: "7.1.1", ffprobeVersion: "7.1.1" },
  });

const inspection = (framesPerSecond = 30) => ({
  durationSeconds: 30,
  encodedDimensions: { width: 1_920, height: 1_080 },
  displayDimensions: { width: 1_920, height: 1_080 },
  rotationDegrees: 0,
  frameRate: { numerator: framesPerSecond, denominator: 1, framesPerSecond },
  primaryVideoStream: { index: 0, type: "video", codec: "h264", width: 1_920, height: 1_080 },
  audioStreams: [{ index: 1, type: "audio", codec: "aac", channels: 2 }],
  streams: [
    { index: 0, type: "video", codec: "h264" },
    { index: 1, type: "audio", codec: "aac" },
  ],
});
