import { randomUUID } from "node:crypto";

import { Effect } from "effect";

import type { Database } from "../database/database.ts";
import {
  claimUploadFinalization,
  expireAwaitingUpload,
  expirePendingUploads,
  findOwnedJob,
  listFinalizingUploads,
  queueFinalizedUpload,
  resetFinalizingUpload,
} from "../database/job-lifecycle-repository.ts";
import { jobs } from "../database/schema.ts";
import {
  publishStoredUpload,
  removeStoredUpload,
  storeUpload,
  verifyStoredUpload,
} from "../storage/upload.ts";
import {
  cleanupJobStaging,
  cleanupJobWorkspace,
  type JobStoragePaths,
  makeJobStoragePaths,
  resolveStagedFile,
} from "../storage/workspace.ts";
import { JobNotFound, JobStateConflict, JobUploadExpired } from "./job-errors.ts";
import { tryJobRepository } from "./job-effect-support.ts";

const MAINTENANCE_BATCH_SIZE = 50;
const MAINTENANCE_CONCURRENCY = 4;

interface JobUploadConfig {
  readonly mediaRoot: string;
  readonly uploadTtlMs: number;
}

export interface UploadJobInput {
  readonly body: ReadableStream<Uint8Array>;
  readonly jobId: string;
  readonly now: number;
  readonly userId: string;
}

export const makeJobUploadService = (database: Database, config: JobUploadConfig) => {
  const upload = Effect.fn("JobUploadService.upload")(function* (input: UploadJobInput) {
    const job = yield* tryJobRepository("find-upload", () => findOwnedJob(database, input));
    if (job === undefined) return yield* new JobNotFound();
    if (job.state !== "awaiting-upload") {
      return yield* new JobStateConflict({ state: job.state });
    }
    if (job.uploadState === "finalizing") {
      return yield* recoverRetriedUpload(database, config, job, input);
    }
    return yield* storePendingUpload(database, config, job, input);
  });

  const maintain = Effect.fn("JobUploadService.maintain")(function* (input: {
    readonly now: number;
  }) {
    const expired = yield* tryJobRepository("expire-pending-uploads", () =>
      expirePendingUploads(database, {
        expiresAt: input.now - config.uploadTtlMs,
        limit: MAINTENANCE_BATCH_SIZE,
        now: input.now,
      }),
    );
    yield* Effect.forEach(
      expired,
      (job) =>
        makeJobStoragePaths(config.mediaRoot, job.id).pipe(Effect.flatMap(cleanupJobWorkspace)),
      { concurrency: MAINTENANCE_CONCURRENCY },
    );
    const finalizing = yield* tryJobRepository("list-finalizing-uploads", () =>
      listFinalizingUploads(database, MAINTENANCE_BATCH_SIZE),
    );
    yield* Effect.forEach(
      finalizing,
      (job) => maintainFinalizingUpload(database, config.mediaRoot, job, input.now),
      { concurrency: MAINTENANCE_CONCURRENCY },
    );
  });

  return { maintain, upload };
};

const recoverRetriedUpload = Effect.fn("JobUploadService.recoverRetriedUpload")(function* (
  database: Database,
  config: JobUploadConfig,
  job: typeof jobs.$inferSelect,
  input: UploadJobInput,
) {
  yield* recoverUpload(database, config.mediaRoot, job, input.now);
  const current = yield* tryJobRepository("find-recovered-upload", () =>
    findOwnedJob(database, input),
  );
  if (current?.state === "queued" && current.inputBytes !== null && current.inputSha256 !== null) {
    return uploadResponse(current.id, current.inputBytes, current.inputSha256);
  }
  if (current?.state === "awaiting-upload" && current.uploadState === "pending") {
    return yield* storePendingUpload(database, config, current, input);
  }
  return yield* new JobStateConflict({ state: current?.state ?? "unknown" });
});

const storePendingUpload = Effect.fn("JobUploadService.storePendingUpload")(function* (
  database: Database,
  config: JobUploadConfig,
  job: typeof jobs.$inferSelect,
  input: UploadJobInput,
) {
  const paths = yield* makeJobStoragePaths(config.mediaRoot, job.id);
  if (input.now >= job.createdAt + config.uploadTtlMs) {
    const expired = yield* tryJobRepository("expire-upload", () =>
      expireAwaitingUpload(database, input),
    );
    if (expired === undefined) {
      const current = yield* tryJobRepository("find-upload-race", () =>
        findOwnedJob(database, input),
      );
      return yield* new JobStateConflict({ state: current?.state ?? "unknown" });
    }
    yield* cleanupJobWorkspace(paths);
    return yield* new JobUploadExpired();
  }

  const stagingFile = `upload-${randomUUID()}`;
  const stagingPath = yield* resolveStagedFile(paths, stagingFile);
  const stored = yield* storeUpload({
    body: input.body,
    declaredBytes: job.declaredBytes,
    destination: stagingPath,
    maxBytes: job.maxUploadBytes,
  });
  const claimed = yield* tryJobRepository("claim-upload", () =>
    claimUploadFinalization(database, { ...input, ...stored, stagingFile }),
  );
  if (claimed === undefined) {
    yield* removeStoredUpload(stagingPath);
    const current = yield* tryJobRepository("find-upload-race", () =>
      findOwnedJob(database, input),
    );
    return yield* new JobStateConflict({ state: current?.state ?? "unknown" });
  }
  yield* recoverUpload(database, config.mediaRoot, claimed, input.now);
  const finalized = yield* tryJobRepository("find-finalized-upload", () =>
    findOwnedJob(database, input),
  );
  if (
    finalized?.state === "queued" &&
    finalized.inputBytes !== null &&
    finalized.inputSha256 !== null
  ) {
    return uploadResponse(finalized.id, finalized.inputBytes, finalized.inputSha256);
  }
  return yield* new JobStateConflict({ state: finalized?.state ?? "unknown" });
});

const uploadResponse = (jobId: string, bytes: number, sha256: string) => ({
  bytes,
  jobId,
  sha256,
  state: "queued" as const,
});

const recoverUpload = Effect.fn("JobUploadService.recoverUpload")(function* (
  database: Database,
  mediaRoot: string,
  job: typeof jobs.$inferSelect,
  now: number,
) {
  const paths = yield* makeJobStoragePaths(mediaRoot, job.id);
  if (job.inputBytes === null || job.inputSha256 === null) {
    yield* resetUpload(database, paths, job, now);
    return;
  }
  const expected = { bytes: job.inputBytes, sha256: job.inputSha256 };
  const inputIsValid = yield* verifyStoredUpload(paths.inputFile, expected);
  if (inputIsValid) {
    if (job.uploadStagingFile !== null) {
      const stagingPath = yield* resolveStagedFile(paths, job.uploadStagingFile);
      yield* removeStoredUpload(stagingPath);
    }
    yield* tryJobRepository("queue-recovered-upload", () =>
      queueFinalizedUpload(database, job.id, now),
    );
    return;
  }
  if (job.uploadStagingFile === null) {
    yield* resetUpload(database, paths, job, now);
    return;
  }
  const stagingPath = yield* resolveStagedFile(paths, job.uploadStagingFile);
  const stagingIsValid = yield* verifyStoredUpload(stagingPath, expected);
  if (!stagingIsValid) {
    yield* resetUpload(database, paths, job, now);
    return;
  }
  yield* removeStoredUpload(paths.inputFile);
  yield* publishStoredUpload(stagingPath, paths.inputFile);
  yield* tryJobRepository("queue-recovered-upload", () =>
    queueFinalizedUpload(database, job.id, now),
  );
});

const maintainFinalizingUpload = Effect.fn("JobUploadService.maintainFinalizingUpload")(function* (
  database: Database,
  mediaRoot: string,
  job: typeof jobs.$inferSelect,
  now: number,
) {
  yield* recoverUpload(database, mediaRoot, job, now);
  yield* cleanupUploadStaging(mediaRoot, job.id);
});

const cleanupUploadStaging = (mediaRoot: string, jobId: string) =>
  makeJobStoragePaths(mediaRoot, jobId).pipe(Effect.flatMap(cleanupJobStaging));

const resetUpload = Effect.fn("JobUploadService.resetUpload")(function* (
  database: Database,
  paths: JobStoragePaths,
  job: typeof jobs.$inferSelect,
  now: number,
) {
  yield* removeStoredUpload(paths.inputFile);
  if (job.uploadStagingFile !== null) {
    const stagingPath = yield* resolveStagedFile(paths, job.uploadStagingFile);
    yield* removeStoredUpload(stagingPath);
  }
  yield* tryJobRepository("reset-finalizing-upload", () =>
    resetFinalizingUpload(database, job.id, now),
  );
});
