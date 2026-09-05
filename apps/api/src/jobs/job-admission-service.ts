import {
  type ExecutionPlanExecuteRequest,
  type ReadyExecutionPlan,
  type ReadyExecutionPlanSnapshot,
} from "@densio/shared";
import { Effect, Result } from "effect";
import type { Entitlements } from "../auth/entitlements.ts";
import type { Database } from "../database/database.ts";
import {
  createJob,
  findJobByIdempotencyKey,
  findOwnedJob,
  listPreparingJobs,
} from "../database/job-repository.ts";
import { transitionJob } from "../database/job-transition-repository.ts";
import type { jobs, executionPlans } from "../database/schema.ts";
import {
  ExecutionPlanClientReferenceConflict,
  ExecutionPlanCreditsUnavailable,
  ExecutionPlanIdempotencyConflict,
} from "../execution-plans/execution-plan-errors.ts";
import { findOwnedReadyPreparedSource } from "../execution-plans/execution-plan-repository.ts";
import { canonicalDigest } from "../idempotency/canonical-digest.ts";
import { attachPreparedSource, SourceAttachmentError } from "../storage/source-attachment.ts";
import { verifyStoredUpload } from "../storage/upload.ts";
import { runMaintenancePages } from "../services/maintenance-pages.ts";
import { makeJobStoragePaths, StorageOperationError } from "../storage/workspace.ts";
import { tryJobRepository } from "./job-effect-support.ts";
import {
  authorizeOrganization,
  type OrganizationActor,
} from "../organizations/organization-access.ts";
import { organizationStorage } from "../organizations/organization-service.ts";
import type { BillingPriceIds } from "../billing/billing-repository.ts";
import { withJobWriteActivity } from "./job-write-activity.ts";

export interface ExecutePlannedJobInput extends ExecutionPlanExecuteRequest, OrganizationActor {
  readonly entitlements: Entitlements;
  readonly idempotencyKey: string;
  readonly now: number;
  readonly planId: string;
  readonly organizationId: string;
}

interface PlannedJobConfig {
  readonly now: () => number;
  readonly priceIds: BillingPriceIds;
  readonly createJobId: () => string;
  readonly mediaRoot: string;
  readonly publicBaseUrl: string;
}

export const executePlannedJob = <E>(
  database: Database,
  config: PlannedJobConfig,
  input: ExecutePlannedJobInput,
  loadPlan: Effect.Effect<ReadyExecutionPlan, E>,
) => {
  return executeResolvedJob(
    database,
    config,
    input,
    canonicalDigest({
      organizationId: input.organizationId,
      operation: "plans.execute",
      planId: input.planId,
      request: {
        clientReference: input.clientReference,
        maxCredits: input.maxCredits,
        maxOutputBytes: input.maxOutputBytes,
      },
    }),
    loadPlan.pipe(Effect.map((plan) => ({ plan }))),
  );
};

type ResolvedJobInput = Omit<ExecutePlannedJobInput, "planId">;
type ResolvedJobPlan = ReadyExecutionPlanSnapshot & { readonly planId: string };
export const executeResolvedJob = Effect.fn("JobAdmissionService.admit")(function* <E>(
  database: Database,
  config: PlannedJobConfig,
  input: ResolvedJobInput,
  requestDigest: string,
  loadPlan: Effect.Effect<
    {
      readonly plan: ResolvedJobPlan;
      readonly pendingSnapshot?: typeof executionPlans.$inferInsert;
    },
    E
  >,
) {
  yield* organizationStorage("authorize-execution", () =>
    authorizeOrganization(database.db, input, "media-write"),
  );
  const existing = yield* tryJobRepository("find-execution-replay", () =>
    findJobByIdempotencyKey(database, input.organizationId, input.idempotencyKey),
  );
  if (existing !== undefined) {
    if (existing.requestDigest !== requestDigest)
      return yield* new ExecutionPlanIdempotencyConflict();
    const job = yield* preparePlannedJob(database, config.mediaRoot, existing, input.now);
    return executionResponse(job, true, config.publicBaseUrl);
  }
  const { plan, pendingSnapshot } = yield* loadPlan;
  const creation = yield* tryJobRepository("create-planned-job", () =>
    createJob(
      database,
      plannedJobValues(plan, config.createJobId(), input, requestDigest),
      {
        actor: input,
        now: config.now(),
        priceIds: config.priceIds,
      },
      pendingSnapshot,
    ),
  );
  if ("kind" in creation) {
    if (creation.kind === "client-reference-conflict")
      return yield* new ExecutionPlanClientReferenceConflict();
    if (creation.kind === "idempotency-conflict")
      return yield* new ExecutionPlanIdempotencyConflict();
    if (creation.kind === "insufficient-credits")
      return yield* new ExecutionPlanCreditsUnavailable({
        availableCredits: creation.availableCredits,
        requiredCredits: plan.quote.credits,
      });
  }
  const job = yield* preparePlannedJob(database, config.mediaRoot, creation.job, input.now);
  return executionResponse(job, !creation.created, config.publicBaseUrl);
});

export const recoverPreparingJobs = Effect.fn("JobAdmissionService.recover")(function* (
  database: Database,
  mediaRoot: string,
  now: number,
) {
  yield* runMaintenancePages(
    ({ afterId, limit }) =>
      tryJobRepository("list-preparing", () => listPreparingJobs(database, limit, afterId)),
    (job) => preparePlannedJob(database, mediaRoot, job, now),
    "Job input preparation",
  );
});

const preparePlannedJob = Effect.fn("JobAdmissionService.prepare")(function* (
  database: Database,
  mediaRoot: string,
  job: typeof jobs.$inferSelect,
  now: number,
) {
  if (job.state !== "preparing") return job;
  const attachment = yield* withJobWriteActivity(
    database,
    job,
    attachInput(database, mediaRoot, job, now),
  ).pipe(Effect.result);
  if (
    Result.isFailure(attachment) &&
    (attachment.failure instanceof StorageOperationError ||
      (attachment.failure instanceof SourceAttachmentError && attachment.failure.retryable))
  ) {
    return yield* Effect.fail(attachment.failure);
  }
  const updated = yield* tryJobRepository("finish-preparation", () =>
    transitionJob(database, {
      jobId: job.id,
      now,
      command: { type: Result.isSuccess(attachment) ? "source-attached" : "attachment-failed" },
    }),
  );
  return (
    updated ??
    (yield* tryJobRepository("refetch-prepared-job", () =>
      findOwnedJob(database, { jobId: job.id, organizationId: job.organizationId }),
    )) ??
    job
  );
});

const attachInput = Effect.fn("JobAdmissionService.attachInput")(function* (
  database: Database,
  mediaRoot: string,
  job: typeof jobs.$inferSelect,
  now: number,
) {
  const expected = { bytes: job.inputBytes, sha256: job.inputSha256 };
  const paths = yield* makeJobStoragePaths(mediaRoot, job.id);
  if (yield* verifyStoredUpload(paths.inputFile, expected)) return;
  const source = yield* tryJobRepository("find-attachment-source", () =>
    findOwnedReadyPreparedSource(database, job.sourceId, job.organizationId, now),
  );
  if (source === undefined) return yield* Effect.fail("source-unavailable");
  yield* attachPreparedSource({ expected, jobId: job.id, mediaRoot, sourceId: job.sourceId });
});

const plannedJobValues = (
  plan: ResolvedJobPlan,
  id: string,
  input: ResolvedJobInput,
  requestDigest: string,
): typeof jobs.$inferInsert => ({
  id,
  createdByUserId: input.userId,
  organizationId: input.organizationId,
  kind: plan.workflow,
  state: "preparing",
  subscriptionPlan: input.entitlements.plan,
  sourceId: plan.source.sourceId,
  executionPlanId: plan.planId,
  sourceFilename: plan.source.filename,
  declaredBytes: plan.source.declaredBytes,
  inputBytes: plan.source.verifiedBytes,
  inputSha256: plan.source.sha256,
  requestedOptionsJson: JSON.stringify(plan.requestedOptions),
  resolvedOptionsJson: JSON.stringify(plan.resolvedOptions),
  inspectionJson: JSON.stringify(plan.source.inspection),
  intentDigest: plan.intentDigest,
  requestDigest,
  idempotencyKey: input.idempotencyKey,
  clientReference: input.clientReference ?? null,
  quoteCreditUnits: plan.quote.creditUnits,
  maxOutputBytes: strictestOutputLimit(plan.constraints?.maxOutputBytes, input.maxOutputBytes),
  progressJson: JSON.stringify({ phase: "preparing", percent: 0, attempt: 0, revision: 0 }),
  createdAt: input.now,
  updatedAt: input.now,
});

const strictestOutputLimit = (left: number | undefined, right: number | undefined) =>
  left === undefined ? (right ?? null) : right === undefined ? left : Math.min(left, right);

const executionResponse = (
  job: typeof jobs.$inferSelect,
  replayed: boolean,
  publicBaseUrl: string,
) => ({
  organizationId: job.organizationId,
  jobId: job.id,
  state: job.state,
  replayed,
  statusUrl: new URL(
    `/v1/organizations/${job.organizationId}/jobs/${job.id}`,
    publicBaseUrl,
  ).toString(),
});
