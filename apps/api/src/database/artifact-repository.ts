import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { ArtifactKind } from "@densio/shared";
import { and, asc, eq, isNull, lte } from "drizzle-orm";
import { Effect, Schema } from "effect";

import {
  artifactTokenLookupHash,
  createArtifactAccessToken,
  ensureArtifactTokenActive,
} from "../storage/artifact.ts";
import type { Database } from "./database.ts";
import { artifacts } from "./schema.ts";

export class ArtifactUnavailable extends Schema.TaggedErrorClass<ArtifactUnavailable>()(
  "ArtifactUnavailable",
  { reason: Schema.Literals(["invalid", "expired", "deleted"]) },
) {}

export class ArtifactRepositoryError extends Schema.TaggedErrorClass<ArtifactRepositoryError>()(
  "ArtifactRepositoryError",
  { cause: Schema.Defect(), operation: Schema.String },
) {}

interface RegisterArtifactInput {
  readonly expiresAt: number;
  readonly filename: string;
  readonly jobId: string;
  readonly kind: ArtifactKind;
  readonly mediaType: string;
  readonly now: number;
  readonly path: string;
  readonly publicBaseUrl: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export const registerArtifact = Effect.fn("ArtifactRepository.register")(function* (
  database: Database,
  input: RegisterArtifactInput,
) {
  const id = randomUUID();
  const access = createArtifactAccessToken(input.expiresAt);
  yield* tryRepository("register", () =>
    database.db
      .insert(artifacts)
      .values({
        accessTokenHash: access.accessTokenHash,
        createdAt: input.now,
        expiresAt: input.expiresAt,
        filename: input.filename,
        id,
        jobId: input.jobId,
        kind: input.kind,
        mediaType: input.mediaType,
        path: input.path,
        sha256: input.sha256,
        sizeBytes: input.sizeBytes,
      })
      .run(),
  );
  const downloadUrl = new URL(
    `/v1/artifacts/${id}/${access.token}/${encodeURIComponent(input.filename)}`,
    input.publicBaseUrl,
  ).toString();
  return { accessToken: access.token, downloadUrl, id } as const;
});

export const findSignedArtifact = Effect.fn("ArtifactRepository.findSigned")(function* (
  database: Database,
  input: { readonly artifactId: string; readonly now: number; readonly token: unknown },
) {
  const accessTokenHash = yield* artifactTokenLookupHash(input.token).pipe(
    Effect.mapError(() => new ArtifactUnavailable({ reason: "invalid" })),
  );
  const artifact = yield* tryRepository("find-signed", () =>
    database.db
      .select()
      .from(artifacts)
      .where(
        and(eq(artifacts.id, input.artifactId), eq(artifacts.accessTokenHash, accessTokenHash)),
      )
      .get(),
  );
  if (artifact === undefined) return yield* new ArtifactUnavailable({ reason: "invalid" });
  if (artifact.deletedAt !== null) return yield* new ArtifactUnavailable({ reason: "deleted" });
  yield* ensureArtifactTokenActive(artifact.expiresAt, input.now).pipe(
    Effect.mapError(() => new ArtifactUnavailable({ reason: "expired" })),
  );
  return artifact;
});

export const cleanupExpiredArtifacts = Effect.fn("ArtifactRepository.cleanupExpired")(function* (
  database: Database,
  input: { readonly mediaRoot: string; readonly now: number },
) {
  const expired = yield* tryRepository("list-expired", () =>
    database.db
      .select()
      .from(artifacts)
      .where(and(lte(artifacts.expiresAt, input.now), isNull(artifacts.deletedAt)))
      .orderBy(asc(artifacts.expiresAt))
      .all(),
  );
  const outcomes = yield* Effect.forEach(expired, (artifact) =>
    cleanupArtifact(database, artifact, input),
  );
  return outcomes.reduce(
    (totals, outcome) => ({
      deleted: totals.deleted + (outcome === "deleted" ? 1 : 0),
      failed: totals.failed + (outcome === "failed" ? 1 : 0),
    }),
    { deleted: 0, failed: 0 },
  );
});

const cleanupArtifact = Effect.fn("ArtifactRepository.cleanupOne")(function* (
  database: Database,
  artifact: typeof artifacts.$inferSelect,
  input: { readonly mediaRoot: string; readonly now: number },
) {
  if (!isPathInside(input.mediaRoot, artifact.path)) {
    yield* recordDeletionFailure(database, artifact.id, "unsafe-path");
    return "failed" as const;
  }

  const deletion = yield* Effect.match(
    Effect.tryPromise({ catch: nodeErrorCode, try: () => unlink(artifact.path) }),
    {
      onFailure: (code) => (code === "ENOENT" ? "deleted" : code),
      onSuccess: () => "deleted" as const,
    },
  );
  if (deletion !== "deleted") {
    yield* recordDeletionFailure(database, artifact.id, deletion);
    return "failed" as const;
  }

  yield* tryRepository("mark-deleted", () =>
    database.db
      .update(artifacts)
      .set({ deletedAt: input.now, deletionError: null })
      .where(eq(artifacts.id, artifact.id))
      .run(),
  );
  return "deleted" as const;
});

const recordDeletionFailure = (database: Database, id: string, deletionError: string) =>
  tryRepository("record-deletion-failure", () =>
    database.db
      .update(artifacts)
      .set({ deletionError: deletionError.slice(0, 100) })
      .where(eq(artifacts.id, id))
      .run(),
  );

const isPathInside = (root: string, path: string) => {
  const relativePath = relative(resolve(root), resolve(path));
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
};

const nodeErrorCode = (cause: unknown) => {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return "delete-failed";
  return typeof cause.code === "string" ? cause.code : "delete-failed";
};

const tryRepository = Effect.fn("ArtifactRepository.try")(
  <Value>(operation: string, evaluate: () => Value) =>
    Effect.try({
      catch: (cause) => new ArtifactRepositoryError({ cause, operation }),
      try: evaluate,
    }),
);
