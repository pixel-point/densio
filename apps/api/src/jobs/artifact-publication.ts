import { randomUUID } from "node:crypto";
import { rename, stat } from "node:fs/promises";

import type { ArtifactReceipt, HlsPackage } from "@densio/shared";
import { eq } from "drizzle-orm";
import { Clock, Effect, Schema } from "effect";

import type { Database } from "../database/database.ts";
import { applyJobTransition, transitionJob } from "../database/job-transition-repository.ts";
import { artifacts, hlsPackages } from "../database/schema.ts";
import { publishStagedArtifact } from "../storage/artifact.ts";
import type { JobStoragePaths } from "../storage/workspace.ts";
import {
  prepareJobWorkspace,
  resolveArtifactFile,
  resolveStagedFile,
} from "../storage/workspace.ts";
import type { StagedWorkflowOutput } from "../media/workflows/workflow-types.ts";
import type { Job } from "./job-worker.ts";

export class ArtifactPublicationError extends Schema.TaggedErrorClass<ArtifactPublicationError>()(
  "ArtifactPublicationError",
  { message: Schema.String, operation: Schema.String },
) {}

export class ArtifactOutputSizeLimitExceeded extends Schema.TaggedErrorClass<ArtifactOutputSizeLimitExceeded>()(
  "ArtifactOutputSizeLimitExceeded",
  { actualBytes: Schema.Int, limitBytes: Schema.Int },
) {}

interface ArtifactPublicationConfig {
  readonly artifactTtlMs: number;
}

export const publishAndRegisterArtifacts = Effect.fn("MediaJob.publishArtifacts")(function* (
  database: Database,
  config: ArtifactPublicationConfig,
  job: Job,
  paths: JobStoragePaths,
  outputs: ReadonlyArray<StagedWorkflowOutput>,
  hlsPackage?: HlsPackage,
) {
  const totalBytes = Math.max(
    yield* measureStagedOutputs(paths, outputs),
    hlsPackage?.packageBytes ?? 0,
  );
  if (job.maxOutputBytes !== null && totalBytes > job.maxOutputBytes) {
    return yield* new ArtifactOutputSizeLimitExceeded({
      actualBytes: totalBytes,
      limitBytes: job.maxOutputBytes,
    });
  }
  const publishingAt = yield* Clock.currentTimeMillis;
  const publishing = yield* Effect.try({
    try: () =>
      transitionJob(database, {
        jobId: job.id,
        now: publishingAt,
        command: { type: "publishing", workerId: job.leaseOwner ?? "", attempt: job.attemptCount },
      }),
    catch: () =>
      new ArtifactPublicationError({
        message: "Publication transition failed.",
        operation: "begin-publication",
      }),
  });
  if (publishing === undefined)
    return yield* new ArtifactPublicationError({
      message: "The publication lease is no longer active.",
      operation: "begin-publication",
    });
  yield* prepareJobWorkspace(paths, { includeArtifactDirectory: true });
  const packageDirectory = hlsPackage === undefined ? undefined : yield* publishHlsDirectory(paths);
  const published = yield* Effect.forEach(outputs, (output) =>
    publishStagedArtifact(paths, {
      artifactFilename: output.artifactFilename,
      stagedFilename: output.stagedFilename,
    }),
  );
  const now = yield* Clock.currentTimeMillis;
  const retainedUntil = now + config.artifactTtlMs;
  const registrations = outputs.map((output, index) => {
    const file = published[index];
    if (file === undefined) {
      throw new ArtifactPublicationError({
        message: "A published artifact is missing.",
        operation: "pair-published-output",
      });
    }
    const id = randomUUID();
    return { file, id, output };
  });

  yield* Effect.try({
    catch: () =>
      new ArtifactPublicationError({
        message: "Artifact registration failed.",
        operation: "register-artifacts",
      }),
    try: () =>
      registerPublication(
        database,
        job,
        registrations,
        now,
        retainedUntil,
        hlsPackage && packageDirectory
          ? { contents: hlsPackage, directory: packageDirectory }
          : undefined,
      ),
  });

  return registrations.map(({ file, id, output }) => ({
    organizationId: job.organizationId,
    bytes: file.sizeBytes,
    retainedUntil: new Date(retainedUntil).toISOString(),
    filename: output.artifactFilename,
    id,
    kind: output.kind,
    mediaType: output.mediaType,
    sha256: file.sha256,
    ...(output.codec === undefined ? {} : { codec: output.codec }),
    ...(output.width === undefined ? {} : { width: output.width }),
    ...(output.height === undefined ? {} : { height: output.height }),
    ...(output.durationSeconds === undefined ? {} : { durationSeconds: output.durationSeconds }),
  })) satisfies ReadonlyArray<ArtifactReceipt>;
});

const registerPublication = (
  database: Database,
  job: Job,
  registrations: ReadonlyArray<{
    readonly file: { readonly path: string; readonly sha256: string; readonly sizeBytes: number };
    readonly id: string;
    readonly output: StagedWorkflowOutput;
  }>,
  now: number,
  retainedUntil: number,
  hlsPackage?: { readonly contents: HlsPackage; readonly directory: string },
) =>
  database.db.transaction(
    (transaction) => {
      const current = applyJobTransition(transaction, {
        jobId: job.id,
        now,
        command: {
          type: "artifact-published",
          workerId: job.leaseOwner ?? "",
          attempt: job.attemptCount,
        },
      });
      if (current === undefined) throw new Error("The job publication lease is no longer active.");

      // A worker can crash after publication but before the terminal transition. Replacing the
      // unfinished attempt's rows makes a leased retry converge on one authoritative artifact set.
      transaction.delete(artifacts).where(eq(artifacts.jobId, current.id)).run();
      transaction
        .insert(artifacts)
        .values(artifactRows(registrations, current, now, retainedUntil))
        .run();
      if (hlsPackage) {
        const archive = registrations.find(({ output }) => output.kind === "hls-archive");
        if (!archive) throw new Error("HLS publication requires an archive");
        transaction
          .insert(hlsPackages)
          .values({
            id: hlsPackage.contents.packageId,
            organizationId: job.organizationId,
            jobId: job.id,
            artifactId: archive.id,
            directory: hlsPackage.directory,
            inventoryJson: JSON.stringify(hlsPackage.contents),
            packageBytes: hlsPackage.contents.packageBytes,
            createdAt: now,
          })
          .run();
      }
    },
    { behavior: "immediate" },
  );

const artifactRows = (
  registrations: Parameters<typeof registerPublication>[2],
  job: Job,
  now: number,
  retainedUntil: number,
) =>
  registrations.map(({ file, id, output }) => ({
    createdAt: now,
    filename: output.artifactFilename,
    id,
    jobId: job.id,
    organizationId: job.organizationId,
    kind: output.kind,
    mediaType: output.mediaType,
    path: file.path,
    retainedUntil,
    sha256: file.sha256,
    sizeBytes: file.sizeBytes,
    ...(output.codec === undefined ? {} : { codec: output.codec }),
    ...(output.width === undefined ? {} : { width: output.width }),
    ...(output.height === undefined ? {} : { height: output.height }),
    ...(output.durationSeconds === undefined ? {} : { durationSeconds: output.durationSeconds }),
  }));

const measureStagedOutputs = Effect.fn("MediaJob.measureStagedOutputs")(function* (
  paths: JobStoragePaths,
  outputs: ReadonlyArray<StagedWorkflowOutput>,
) {
  const sizes = yield* Effect.forEach(outputs, (output) =>
    Effect.flatMap(resolveStagedFile(paths, output.stagedFilename), (path) =>
      Effect.tryPromise({
        catch: () =>
          new ArtifactPublicationError({
            message: "A staged artifact could not be measured.",
            operation: "measure-staged-output",
          }),
        try: () => stat(path),
      }),
    ),
  );
  return sizes.reduce((total, metadata) => total + metadata.size, 0);
});

const publishHlsDirectory = Effect.fn("MediaJob.publishHlsDirectory")(function* (
  paths: JobStoragePaths,
) {
  const packageDirectory = yield* resolveArtifactFile(paths, "hls");
  if (packageDirectory !== undefined) {
    const staged = yield* resolveStagedFile(paths, "hls");
    yield* Effect.tryPromise({
      try: () => rename(staged, packageDirectory),
      catch: () =>
        new ArtifactPublicationError({
          message: "HLS package publication failed.",
          operation: "publish-package",
        }),
    });
  }
  return packageDirectory;
});
