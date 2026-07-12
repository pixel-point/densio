import { randomUUID } from "node:crypto";

import {
  JobResultSchema,
  type JobSource,
  type JobStatus,
  type JobWorkflow,
  type Plan,
} from "@ffmpeg-api/shared";
import { Effect, Schema } from "effect";

import type { Database } from "../database/database.ts";
import {
  expireAwaitingUpload,
  findOwnedJob,
  queueUploadedJob,
} from "../database/job-lifecycle-repository.ts";
import { createJob, requestJobCancellation } from "../database/job-repository.ts";
import { jobs } from "../database/schema.ts";
import { makeProblem, toProblemDetails } from "../errors/problem-details.ts";
import { storeUpload } from "../storage/upload.ts";
import {
  cleanupJobWorkspace,
  makeJobStoragePaths,
  prepareJobWorkspace,
} from "../storage/workspace.ts";

export class JobIdempotencyConflict extends Schema.TaggedErrorClass<JobIdempotencyConflict>()(
  "JobIdempotencyConflict",
  {},
) {}

export class JobUploadExpired extends Schema.TaggedErrorClass<JobUploadExpired>()(
  "JobUploadExpired",
  {},
) {}

export class JobNotFound extends Schema.TaggedErrorClass<JobNotFound>()("JobNotFound", {}) {}

export class JobStateConflict extends Schema.TaggedErrorClass<JobStateConflict>()(
  "JobStateConflict",
  { state: Schema.String },
) {}

export class JobUploadLimitExceeded extends Schema.TaggedErrorClass<JobUploadLimitExceeded>()(
  "JobUploadLimitExceeded",
  { limitBytes: Schema.Number },
) {}

export class JobRepositoryError extends Schema.TaggedErrorClass<JobRepositoryError>()(
  "JobRepositoryError",
  { cause: Schema.Defect(), operation: Schema.String },
) {}

interface JobServiceConfig {
  readonly maxUploadBytes: number;
  readonly mediaRoot: string;
  readonly publicBaseUrl: string;
  readonly uploadTtlMs: number;
}

interface CreateJobInput {
  readonly idempotencyKey?: string;
  readonly now: number;
  readonly options: Schema.Json;
  readonly plan: Plan;
  readonly source: JobSource;
  readonly userId: string;
  readonly workflow: JobWorkflow;
}

interface UploadJobInput {
  readonly body: ReadableStream<Uint8Array>;
  readonly jobId: string;
  readonly now: number;
  readonly userId: string;
}

interface OwnedJobInput {
  readonly correlationId: string;
  readonly jobId: string;
  readonly userId: string;
}

export const makeJobService = (database: Database, config: JobServiceConfig) => {
  const create = Effect.fn("JobService.create")(function* (input: CreateJobInput) {
    if (input.source.bytes > config.maxUploadBytes) {
      return yield* new JobUploadLimitExceeded({ limitBytes: config.maxUploadBytes });
    }

    const optionsJson = JSON.stringify(input.options);
    const jobId = randomUUID();
    const paths = yield* makeJobStoragePaths(config.mediaRoot, jobId);
    yield* prepareJobWorkspace(paths).pipe(
      Effect.tapError(() => ignoreCleanup(cleanupJobWorkspace(paths))),
    );
    const creation = yield* tryRepository("create", () =>
      createJob(database, {
        createdAt: input.now,
        declaredBytes: input.source.bytes,
        id: jobId,
        idempotencyKey: input.idempotencyKey,
        kind: input.workflow,
        optionsJson,
        plan: input.plan,
        sourceFilename: input.source.filename,
        state: "awaiting-upload",
        updatedAt: input.now,
        userId: input.userId,
      }),
    ).pipe(Effect.tapError(() => ignoreCleanup(cleanupJobWorkspace(paths))));

    if (!creation.created) {
      yield* cleanupJobWorkspace(paths);
      if (!matchesIdempotentRequest(creation.job, input, optionsJson)) {
        return yield* new JobIdempotencyConflict();
      }
    }
    return createdResponse(creation.job, config);
  });

  const upload = Effect.fn("JobService.upload")(function* (input: UploadJobInput) {
    const job = yield* tryRepository("find-upload", () => findOwnedJob(database, input));
    if (job === undefined) return yield* new JobNotFound();
    if (job.state !== "awaiting-upload") {
      return yield* new JobStateConflict({ state: job.state });
    }

    const paths = yield* makeJobStoragePaths(config.mediaRoot, job.id);
    if (input.now >= job.createdAt + config.uploadTtlMs) {
      const expired = yield* tryRepository("expire-upload", () =>
        expireAwaitingUpload(database, input),
      );
      if (expired === undefined) {
        const current = yield* tryRepository("find-upload-race", () =>
          findOwnedJob(database, input),
        );
        return yield* new JobStateConflict({ state: current?.state ?? "unknown" });
      }
      yield* cleanupJobWorkspace(paths);
      return yield* new JobUploadExpired();
    }

    const stored = yield* storeUpload({
      body: input.body,
      declaredBytes: job.declaredBytes,
      destination: paths.inputFile,
      maxBytes: config.maxUploadBytes,
    });
    const queued = yield* tryRepository("queue-upload", () =>
      queueUploadedJob(database, { ...input, ...stored }),
    );
    if (queued === undefined) return yield* new JobStateConflict({ state: "unknown" });
    return { bytes: stored.bytes, jobId: job.id, sha256: stored.sha256, state: "queued" as const };
  });

  return { create, upload, ...makeOwnedJobOperations(database, config) };
};

const makeOwnedJobOperations = (database: Database, config: JobServiceConfig) => {
  const status = Effect.fn("JobService.status")(function* (input: OwnedJobInput) {
    const job = yield* tryRepository("find-status", () => findOwnedJob(database, input));
    if (job === undefined) return yield* new JobNotFound();
    return yield* toJobStatus(job, input.correlationId);
  });

  const cancel = Effect.fn("JobService.cancel")(function* (
    input: OwnedJobInput & { readonly now: number },
  ) {
    const existing = yield* tryRepository("find-cancel", () => findOwnedJob(database, input));
    if (existing === undefined) return yield* new JobNotFound();
    const job = yield* tryRepository("cancel", () =>
      requestJobCancellation(database, input.jobId, input.userId, input.now),
    );
    if (job === undefined) return yield* new JobNotFound();
    if (job.state === "canceled") {
      const paths = yield* makeJobStoragePaths(config.mediaRoot, job.id);
      yield* cleanupJobWorkspace(paths);
    }
    return yield* toJobStatus(job, input.correlationId);
  });

  return { cancel, status };
};

const toJobStatus = Effect.fn("JobService.toStatus")(function* (
  job: typeof jobs.$inferSelect,
  correlationId: string,
) {
  const base = {
    createdAt: new Date(job.createdAt).toISOString(),
    id: job.id,
    plan: job.plan,
    updatedAt: new Date(job.updatedAt).toISOString(),
    workflow: job.kind,
  };
  if (job.state === "succeeded") {
    return {
      ...base,
      progressPercent: 100 as const,
      result: yield* decodeStoredResult(job.resultJson),
      state: "succeeded" as const,
    } satisfies JobStatus;
  }
  if (job.state === "failed") {
    return {
      ...base,
      problem: toFailedProblem(job, correlationId),
      progressPercent: job.progress,
      state: "failed" as const,
    } satisfies JobStatus;
  }
  if (job.state === "expired") {
    return {
      ...base,
      progressPercent: 100 as const,
      state: "expired" as const,
    } satisfies JobStatus;
  }
  return {
    ...base,
    progressPercent: job.progress,
    state: job.state,
  } satisfies JobStatus;
});

const decodeStoredResult = Effect.fn("JobService.decodeResult")(function* (value: string | null) {
  if (value === null) {
    return yield* new JobRepositoryError({ cause: "missing-result", operation: "decode-result" });
  }
  const parsed = yield* Effect.try({
    catch: (cause) => new JobRepositoryError({ cause, operation: "decode-result" }),
    try: (): unknown => JSON.parse(value),
  });
  return yield* Schema.decodeUnknownEffect(JobResultSchema)(parsed).pipe(
    Effect.mapError((cause) => new JobRepositoryError({ cause, operation: "decode-result" })),
  );
});

const toFailedProblem = (job: typeof jobs.$inferSelect, correlationId: string) =>
  toProblemDetails(
    makeProblem({
      code:
        job.errorCode !== null && /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(job.errorCode)
          ? job.errorCode
          : "JOB_FAILED",
      detail: "The media job could not be completed.",
      jobId: job.id,
      retryable: false,
      status: 422,
      suggestedAction: "Check the source media and options, then create a new job.",
      title: "Media job failed",
    }),
    correlationId,
  );

const createdResponse = (job: ReturnType<typeof createJob>["job"], config: JobServiceConfig) => ({
  jobId: job.id,
  state: "awaiting-upload" as const,
  statusUrl: new URL(`/v1/jobs/${job.id}`, config.publicBaseUrl).toString(),
  upload: {
    expiresAt: new Date(job.createdAt + config.uploadTtlMs).toISOString(),
    method: "PUT" as const,
    url: new URL(`/v1/jobs/${job.id}/upload`, config.publicBaseUrl).toString(),
  },
});

const matchesIdempotentRequest = (
  job: ReturnType<typeof createJob>["job"],
  input: CreateJobInput,
  optionsJson: string,
) =>
  job.kind === input.workflow &&
  job.declaredBytes === input.source.bytes &&
  job.sourceFilename === input.source.filename &&
  job.optionsJson === optionsJson;

const ignoreCleanup = (cleanup: Effect.Effect<void, unknown>) =>
  cleanup.pipe(Effect.catch(() => Effect.void));

const tryRepository = Effect.fn("JobService.repository")(
  <Value>(operation: string, evaluate: () => Value) =>
    Effect.try({
      catch: (cause) => new JobRepositoryError({ cause, operation }),
      try: evaluate,
    }),
);
