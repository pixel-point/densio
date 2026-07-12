import { randomUUID } from "node:crypto";

import type { ArtifactMetadata } from "@ffmpeg-api/shared";
import { Clock, Effect, Schema } from "effect";

import type { Database } from "../database/database.ts";
import { artifacts } from "../database/schema.ts";
import { createArtifactAccessToken, publishStagedArtifact } from "../storage/artifact.ts";
import type { JobStoragePaths } from "../storage/workspace.ts";
import { prepareJobWorkspace } from "../storage/workspace.ts";
import type { StagedWorkflowOutput } from "../media/workflows/workflow-types.ts";
import type { Job } from "./job-worker.ts";

export class ArtifactPublicationError extends Schema.TaggedErrorClass<ArtifactPublicationError>()(
  "ArtifactPublicationError",
  { message: Schema.String, operation: Schema.String },
) {}

interface ArtifactPublicationConfig {
  readonly artifactTtlMs: number;
  readonly publicBaseUrl: string;
}

export const publishAndRegisterArtifacts = Effect.fn("MediaJob.publishArtifacts")(function* (
  database: Database,
  config: ArtifactPublicationConfig,
  job: Job,
  paths: JobStoragePaths,
  outputs: ReadonlyArray<StagedWorkflowOutput>,
) {
  yield* prepareJobWorkspace(paths, { includeArtifactDirectory: true });
  const published = yield* Effect.forEach(outputs, (output) =>
    publishStagedArtifact(paths, {
      artifactFilename: output.artifactFilename,
      stagedFilename: output.stagedFilename,
    }),
  );
  const now = yield* Clock.currentTimeMillis;
  const expiresAt = now + config.artifactTtlMs;
  const registrations = outputs.map((output, index) => {
    const file = published[index];
    if (file === undefined) {
      throw new ArtifactPublicationError({
        message: "A published artifact is missing.",
        operation: "pair-published-output",
      });
    }
    const id = randomUUID();
    const access = createArtifactAccessToken(expiresAt);
    const downloadUrl = new URL(
      `/v1/artifacts/${id}/${access.token}/${encodeURIComponent(output.artifactFilename)}`,
      config.publicBaseUrl,
    ).toString();
    return { access, downloadUrl, file, id, output };
  });

  yield* Effect.try({
    catch: () =>
      new ArtifactPublicationError({
        message: "Artifact registration failed.",
        operation: "register-artifacts",
      }),
    try: () =>
      database.db.transaction(
        (transaction) =>
          transaction
            .insert(artifacts)
            .values(
              registrations.map(({ access, file, id, output }) => ({
                accessTokenHash: access.accessTokenHash,
                createdAt: now,
                expiresAt,
                filename: output.artifactFilename,
                id,
                jobId: job.id,
                kind: output.kind,
                mediaType: output.mediaType,
                path: file.path,
                sha256: file.sha256,
                sizeBytes: file.sizeBytes,
              })),
            )
            .run(),
        { behavior: "immediate" },
      ),
  });

  return registrations.map(({ downloadUrl, file, id, output }) => ({
    bytes: file.sizeBytes,
    downloadUrl,
    expiresAt: new Date(expiresAt).toISOString(),
    filename: output.artifactFilename,
    id,
    kind: output.kind,
    mediaType: output.mediaType,
    sha256: file.sha256,
    ...(output.codec === undefined ? {} : { codec: output.codec }),
  })) satisfies ReadonlyArray<ArtifactMetadata>;
});
