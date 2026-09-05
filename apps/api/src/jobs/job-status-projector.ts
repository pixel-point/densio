import {
  JobExecutionReceiptSchema,
  JobProgressSchema,
  JobResultSchema,
  JobStatusSchema,
  JobSummarySchema,
  type ArtifactDescriptor,
  type JobAction,
} from "@densio/shared";
import { videos } from "../database/video-storage-schema.ts";
import { readVideo } from "../videos/video-catalog.ts";
import { asc, eq } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { toArtifactDescriptor } from "../artifacts/artifact-descriptor.ts";
import type { Database } from "../database/database.ts";
import { artifacts, type jobs } from "../database/schema.ts";
import { tryJobRepository } from "./job-effect-support.ts";
import { JobRepositoryError } from "./job-errors.ts";
import { toFailedProblem } from "./job-failure-problem.ts";
import { isTerminalJob } from "./job-transition.ts";

export interface JobProjectionConfig {
  readonly now: () => number;
  readonly publicBaseUrl: string;
}

export const projectJobStatus = Effect.fn("JobStatusProjector.status")(function* (
  database: Database,
  job: typeof jobs.$inferSelect,
  correlationId: string,
  config: JobProjectionConfig,
) {
  const inventory = yield* jobInventory(database, job, config);
  const base = yield* jobSummary(job, config.publicBaseUrl, inventory);
  const receipt = isTerminalJob(job.state)
    ? yield* decodeStored(JobExecutionReceiptSchema, job.receiptJson)
    : undefined;
  return yield* Schema.decodeUnknownEffect(JobStatusSchema)({
    ...base,
    ...automaticStorage(database, job),
    ...(receipt === undefined ? {} : { receipt }),
    ...(job.state === "succeeded"
      ? { artifacts: inventory, result: yield* decodeStored(JobResultSchema, job.resultJson) }
      : {}),
    ...(job.state === "failed" ? { problem: toFailedProblem(job, correlationId) } : {}),
  }).pipe(
    Effect.mapError((cause) => new JobRepositoryError({ cause, operation: "project-job-status" })),
  );
});

export const projectJobSummary = Effect.fn("JobStatusProjector.summary")(function* (
  database: Database,
  job: typeof jobs.$inferSelect,
  config: JobProjectionConfig,
) {
  return yield* jobSummary(job, config.publicBaseUrl, yield* jobInventory(database, job, config));
});

const jobSummary = Effect.fn("JobStatusProjector.base")(function* (
  job: typeof jobs.$inferSelect,
  publicBaseUrl: string,
  inventory: ReadonlyArray<ArtifactDescriptor>,
) {
  return yield* Schema.decodeUnknownEffect(JobSummarySchema)({
    organizationId: job.organizationId,
    createdByUserId: job.createdByUserId,
    id: job.id,
    sourceId: job.sourceId,
    executionPlanId: job.executionPlanId,
    workflow: job.kind,
    plan: job.subscriptionPlan,
    state: job.state,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
    idempotencyKey: job.idempotencyKey,
    ...(job.clientReference === null ? {} : { clientReference: job.clientReference }),
    actions: jobActions(job, publicBaseUrl, inventory),
    progress: yield* decodeStored(JobProgressSchema, job.progressJson),
  }).pipe(
    Effect.mapError((cause) => new JobRepositoryError({ cause, operation: "project-job-summary" })),
  );
});

const jobActions = (
  job: typeof jobs.$inferSelect,
  publicBaseUrl: string,
  inventory: ReadonlyArray<ArtifactDescriptor>,
): ReadonlyArray<JobAction> => {
  if (!isTerminalJob(job.state))
    return [
      {
        kind: "wait",
        method: "GET",
        url: new URL(
          `/v1/organizations/${job.organizationId}/jobs/${job.id}/events`,
          publicBaseUrl,
        ).toString(),
      },
      {
        kind: "cancel",
        method: "POST",
        url: new URL(
          `/v1/organizations/${job.organizationId}/jobs/${job.id}/cancel`,
          publicBaseUrl,
        ).toString(),
      },
    ];
  const available = inventory.filter(({ availability }) => availability === "available");
  if (available.length === 0) return [];
  return [
    ...available.map(
      (artifact): JobAction => ({
        kind: "authorize-artifacts",
        method: "POST",
        url: artifact.authorizeUrl,
      }),
    ),
    {
      kind: "materialize",
      method: "GET",
      url: new URL(
        `/v1/organizations/${job.organizationId}/jobs/${job.id}`,
        publicBaseUrl,
      ).toString(),
    },
  ];
};

const jobInventory = Effect.fn("JobStatusProjector.inventory")(function* (
  database: Database,
  job: typeof jobs.$inferSelect,
  config: JobProjectionConfig,
) {
  if (job.state !== "succeeded") return [];
  const rows = yield* tryJobRepository("list-job-artifacts", () =>
    database.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.jobId, job.id))
      .orderBy(asc(artifacts.createdAt), asc(artifacts.id))
      .all(),
  );
  return yield* Effect.forEach(rows, (artifact) =>
    toArtifactDescriptor(artifact, config.publicBaseUrl, config.now()),
  );
});

const decodeStored = <S extends Schema.Top>(schema: S, value: string | null) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(value).pipe(
    Effect.mapError((cause) => new JobRepositoryError({ cause, operation: "decode-stored-job" })),
  );

const automaticStorage = (database: Database, job: typeof jobs.$inferSelect) => {
  if (job.state !== "succeeded") return {};
  const video = database.db.select().from(videos).where(eq(videos.automaticJobId, job.id)).get();
  return video ? { video: readVideo(database, job.organizationId, video.id) } : {};
};
