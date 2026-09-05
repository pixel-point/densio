import type { TrimRange, ResolvedTrimRange } from "@densio/shared";
import {
  ExecutionPlanSnapshotSchema,
  type ExecutionPlanCreateRequest,
  type JobCreateRequest,
  type FrameRatePolicy,
} from "@densio/shared";
import { Effect } from "effect";
import { resolveStoragePlan } from "../videos/storage-plan.ts";
import { validateDestination } from "../videos/storage-policy.ts";
import { storageEffect } from "../storage/storage-errors.ts";
import type { Entitlements } from "../auth/entitlements.ts";
import type { Database } from "../database/database.ts";
import {
  executePlannedJob,
  executeResolvedJob,
  type ExecutePlannedJobInput,
} from "../jobs/job-admission-service.ts";
import { canonicalDigest } from "../idempotency/canonical-digest.ts";
import {
  ExecutionPlanCreditGuardExceeded,
  ExecutionPlanDecisionRequired,
  MediaDecisionRequired,
  ExecutionPlanExpired,
  ExecutionPlanIdempotencyConflict,
  ExecutionPlanInvalidOptions,
  ExecutionPlanNotFound,
  ExecutionPlanSourceUnavailable,
  ExecutionPlanStateConflict,
} from "./execution-plan-errors.ts";
import {
  createExecutionPlan,
  findExecutionPlanByIdempotencyKey,
  findOwnedExecutionPlan,
  findOwnedReadyPreparedSource,
} from "./execution-plan-repository.ts";
import {
  decodePlanField,
  decodePlanSource,
  projectExecutionPlan,
  tryPlanStorage,
} from "./execution-plan-projector.ts";
import { buildExecutionPlan } from "./execution-plan-resolver.ts";
import type { BillingPriceIds } from "../billing/billing-repository.ts";
import {
  authorizeOrganization,
  type OrganizationActor,
} from "../organizations/organization-access.ts";
import { organizationStorage } from "../organizations/organization-service.ts";

interface ExecutionPlanServiceConfig {
  readonly managedTargetId?: string;
  readonly managedPublicOrigin?: string;
  readonly now: () => number;
  readonly priceIds: BillingPriceIds;
  readonly createId: () => string;
  readonly createJobId: () => string;
  readonly maxExtractedImages: number;
  readonly maxComparisonSeconds?: number;
  readonly mediaRoot: string;
  readonly planTtlMs: number;
  readonly publicBaseUrl: string;
  readonly resolveTrimRange?: (
    sourceId: string,
    range: TrimRange,
    videoStreamIndex: number,
  ) => Effect.Effect<ResolvedTrimRange, unknown>;
  readonly resolveFrameTimestamp: (
    sourceId: string,
    frameIndex: number,
    videoStreamIndex: number,
  ) => Effect.Effect<number, unknown>;
  readonly toolchain: { readonly ffmpegVersion: string; readonly ffprobeVersion: string };
}
interface CreateInput extends OrganizationActor {
  readonly availableCredits: number;
  readonly entitlements: Entitlements;
  readonly idempotencyKey?: string;
  readonly now: number;
  readonly request: ExecutionPlanCreateRequest;
  readonly organizationId: string;
}
interface OwnedPlanInput extends OrganizationActor {
  readonly now: number;
  readonly planId: string;
  readonly organizationId: string;
}
interface ResolveInput extends OwnedPlanInput {
  readonly availableCredits: number;
  readonly entitlements: Entitlements;
  readonly frameRate: FrameRatePolicy;
  readonly idempotencyKey?: string;
}

export const makeExecutionPlanService = (
  database: Database,
  config: ExecutionPlanServiceConfig,
) => ({
  create: (input: CreateInput) =>
    createSnapshot(
      database,
      config,
      input,
      canonicalDigest({
        organizationId: input.organizationId,
        operation: "plans.create",
        request: input.request,
      }),
    ),
  submit: (
    input: CreateInput & { readonly idempotencyKey: string; readonly request: JobCreateRequest },
  ) =>
    executeResolvedJob(
      database,
      config,
      {
        ...input,
        ...input.request.constraints,
        ...(input.request.clientReference === undefined
          ? {}
          : { clientReference: input.request.clientReference }),
      },
      canonicalDigest({
        organizationId: input.organizationId,
        operation: "jobs.create",
        request: input.request,
      }),
      resolveDirectSubmission(database, config, input),
    ),
  get: (input: OwnedPlanInput) => getPlan(database, config, input),
  resolve: (input: ResolveInput) => resolvePlan(database, config, input),
  execute: (input: ExecutePlannedJobInput & { readonly availableCredits: number }) =>
    executePlannedJob(database, config, input, loadExecutablePlan(database, config, input)),
});

const getPlan = Effect.fn("ExecutionPlanService.get")(function* (
  database: Database,
  config: ExecutionPlanServiceConfig,
  input: OwnedPlanInput,
) {
  yield* organizationStorage("authorize-plan-read", () =>
    authorizeOrganization(database.db, input, "media-read"),
  );
  const row = yield* tryPlanStorage("find-owned-plan", () =>
    findOwnedExecutionPlan(database, input.planId, input.organizationId),
  );
  if (row === undefined) return yield* new ExecutionPlanNotFound();
  return yield* projectExecutionPlan(database, config.publicBaseUrl, row, input.now);
});

const loadExecutablePlan = Effect.fn("ExecutionPlanService.executable")(function* (
  database: Database,
  config: ExecutionPlanServiceConfig,
  input: ExecutePlannedJobInput,
) {
  const plan = yield* getPlan(database, config, input);
  if (plan.availability === "expired") return yield* new ExecutionPlanExpired();
  if (plan.availability === "source-unavailable")
    return yield* new ExecutionPlanSourceUnavailable();
  if (plan.state === "decision-required") return yield* new ExecutionPlanDecisionRequired();
  if (input.maxCredits !== undefined && input.maxCredits < plan.quote.credits) {
    return yield* new ExecutionPlanCreditGuardExceeded({
      maxCredits: input.maxCredits,
      requiredCredits: plan.quote.credits,
    });
  }
  if (
    (plan.workflow === "compress" || plan.workflow === "trim" || plan.workflow === "hls") &&
    plan.storage &&
    "visibility" in plan.storage
  ) {
    const storage = plan.storage;
    yield* storageEffect("execution-plan-service", () =>
      validateDestination(
        database,
        config,
        input.organizationId,
        storage.destination,
        storage.visibility,
      ),
    );
  }
  return plan;
});

const resolvePlan = Effect.fn("ExecutionPlanService.resolve")(function* (
  database: Database,
  config: ExecutionPlanServiceConfig,
  input: ResolveInput,
) {
  const requestDigest = canonicalDigest({
    organizationId: input.organizationId,
    operation: "plans.resolve",
    planId: input.planId,
    request: { frameRate: input.frameRate },
  });
  const replay = yield* replayPlan(database, config, input, requestDigest);
  if (replay !== undefined) {
    if (replay.plan.state !== "ready")
      return yield* new ExecutionPlanStateConflict({ state: replay.plan.state });
    return { ...replay, plan: replay.plan };
  }
  const original = yield* getPlan(database, config, input);
  if (original.availability === "expired") return yield* new ExecutionPlanExpired();
  if (original.availability === "source-unavailable")
    return yield* new ExecutionPlanSourceUnavailable();
  if (original.state !== "decision-required")
    return yield* new ExecutionPlanStateConflict({ state: original.state });
  const created = yield* createSnapshot(
    database,
    config,
    {
      ...input,
      request: {
        sourceId: original.source.sourceId,
        ...(original.workflow === "hls"
          ? {
              workflow: "hls" as const,
              options: { ...original.requestedOptions, frameRate: input.frameRate },
            }
          : {
              workflow: "compress" as const,
              options: { ...original.requestedOptions, frameRate: input.frameRate },
            }),
        ...(original.storage
          ? {
              storage: {
                destination: original.storage.destination,
                ...("visibility" in original.storage
                  ? { visibility: original.storage.visibility, name: original.storage.displayName }
                  : {}),
              },
            }
          : {}),
        ...(original.constraints === undefined ? {} : { constraints: original.constraints }),
      },
    },
    requestDigest,
    original.planId,
  );
  if (created.plan.state !== "ready")
    return yield* new ExecutionPlanStateConflict({ state: created.plan.state });
  return { ...created, plan: created.plan };
});

const createSnapshot = Effect.fn("ExecutionPlanService.create")(function* (
  database: Database,
  config: ExecutionPlanServiceConfig,
  input: CreateInput,
  requestDigest: string,
  supersedesPlanId?: string,
) {
  const replay = yield* replayPlan(database, config, input, requestDigest);
  if (replay !== undefined) return replay;
  const { sourceRow, validated } = yield* resolveSnapshot(database, config, input);
  const creation = yield* tryPlanStorage("create-plan", () =>
    createExecutionPlan(
      database,
      {
        id: config.createId(),
        createdByUserId: input.userId,
        organizationId: input.organizationId,
        sourceId: validated.source.sourceId,
        snapshotJson: JSON.stringify(validated),
        supersedesPlanId: supersedesPlanId ?? null,
        requestDigest,
        idempotencyKey: input.idempotencyKey ?? null,
        createdAt: input.now,
        expiresAt: Math.min(input.now + config.planTtlMs, sourceRow.expiresAt),
      },
      input,
      config.now(),
    ),
  );
  if (creation.plan.requestDigest !== requestDigest)
    return yield* new ExecutionPlanIdempotencyConflict();
  return {
    organizationId: input.organizationId,
    replayed: !creation.created,
    plan: yield* projectExecutionPlan(database, config.publicBaseUrl, creation.plan, input.now),
  };
});

const replayPlan = Effect.fn("ExecutionPlanService.replay")(function* (
  database: Database,
  config: ExecutionPlanServiceConfig,
  input: OrganizationActor & { readonly idempotencyKey?: string; readonly now: number },
  requestDigest: string,
) {
  yield* organizationStorage("authorize-plan-write", () =>
    authorizeOrganization(database.db, input, "media-write"),
  );
  if (input.idempotencyKey === undefined) return undefined;
  const key = input.idempotencyKey;
  const row = yield* tryPlanStorage("find-plan-replay", () =>
    findExecutionPlanByIdempotencyKey(database, input.organizationId, key),
  );
  if (row === undefined) return undefined;
  if (row.requestDigest !== requestDigest) return yield* new ExecutionPlanIdempotencyConflict();
  return {
    organizationId: input.organizationId,
    replayed: true,
    plan: yield* projectExecutionPlan(database, config.publicBaseUrl, row, input.now),
  };
});

const resolveFrameTimestamps = Effect.fn("ExecutionPlanService.resolveFrames")(function* (
  config: ExecutionPlanServiceConfig,
  request: ExecutionPlanCreateRequest,
  videoStreamIndex: number,
) {
  if (request.workflow !== "compare-quality" || request.options.samples?.mode !== "positions")
    return [];
  return yield* Effect.forEach(
    request.options.samples.positions.flatMap((position) =>
      position.kind === "frame" ? [position.frame] : [],
    ),
    (frame) =>
      config.resolveFrameTimestamp(request.sourceId, frame, videoStreamIndex).pipe(
        Effect.mapError(
          () =>
            new ExecutionPlanInvalidOptions({
              message: `Source frame ${frame} could not be resolved.`,
            }),
        ),
      ),
  );
});

const resolveSnapshot = Effect.fn("ExecutionPlanService.resolveSnapshot")(function* (
  database: Database,
  config: ExecutionPlanServiceConfig,
  input: CreateInput,
) {
  const sourceRow = yield* tryPlanStorage("find-source", () =>
    findOwnedReadyPreparedSource(database, input.request.sourceId, input.organizationId, input.now),
  );
  if (sourceRow === undefined) return yield* new ExecutionPlanSourceUnavailable();
  const source = yield* decodePlanSource(sourceRow);
  const storage =
    input.request.workflow === "compress" ||
    input.request.workflow === "trim" ||
    input.request.workflow === "hls"
      ? yield* storageEffect("execution-plan-service", () =>
          resolveStoragePlan(
            database,
            config,
            input.organizationId,
            source.filename,
            input.request as Extract<
              ExecutionPlanCreateRequest,
              { workflow: "compress" | "trim" | "hls" }
            >,
          ),
        )
      : undefined;
  const requestedTrim =
    input.request.workflow === "trim" || input.request.workflow === "compress"
      ? input.request.options?.trim
      : undefined;
  const resolvedTrim =
    requestedTrim === undefined
      ? undefined
      : yield* config.resolveTrimRange
          ? config.resolveTrimRange(
              input.request.sourceId,
              requestedTrim,
              source.inspection.primaryVideoStream.index,
            )
          : Effect.die("Trim timeline resolver is not configured");
  const snapshot = yield* buildExecutionPlan({
    ...(resolvedTrim === undefined ? {} : { resolvedTrim }),
    ...(storage === undefined ? {} : { storage }),
    organizationId: input.organizationId,
    createdByUserId: input.userId,
    availableCredits: input.availableCredits,
    entitlements: input.entitlements,
    maxExtractedImages: config.maxExtractedImages,
    maxComparisonSeconds: config.maxComparisonSeconds ?? 3,
    request: input.request,
    source,
    toolchain: config.toolchain,
    resolvedFrameTimestamps: yield* resolveFrameTimestamps(
      config,
      input.request,
      source.inspection.primaryVideoStream.index,
    ),
  });
  const validated = yield* decodePlanField(ExecutionPlanSnapshotSchema, JSON.stringify(snapshot));
  return { sourceRow, validated };
});

const resolveDirectSubmission = Effect.fn("ExecutionPlanService.directSnapshot")(function* (
  database: Database,
  config: ExecutionPlanServiceConfig,
  input: CreateInput,
) {
  const { sourceRow, validated } = yield* resolveSnapshot(database, config, input);
  if (validated.state === "decision-required")
    return yield* new MediaDecisionRequired({
      sourceId: validated.source.sourceId,
      decision: validated.decision,
    });
  const planId = config.createId();
  return {
    plan: { ...validated, planId },
    pendingSnapshot: {
      id: planId,
      createdByUserId: input.userId,
      organizationId: input.organizationId,
      sourceId: validated.source.sourceId,
      snapshotJson: JSON.stringify(validated),
      requestDigest: canonicalDigest({
        organizationId: input.organizationId,
        operation: "jobs.create",
        request: input.request,
      }),
      createdAt: input.now,
      expiresAt: Math.min(input.now + config.planTtlMs, sourceRow.expiresAt),
    },
  };
});
