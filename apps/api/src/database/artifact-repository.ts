import { artifactHasStorageReader } from "../storage/transfers/input-readers.ts";
import { randomUUID } from "node:crypto";

import { and, asc, eq, gt, isNotNull, isNull, lte, or } from "drizzle-orm";
import { runMaintenancePages } from "../services/maintenance-pages.ts";
import { Effect, Schema } from "effect";

import {
  artifactTokenLookupHash,
  createArtifactAccessToken,
  ensureArtifactTokenActive,
} from "../storage/artifact.ts";
import { artifactAvailability } from "../artifacts/artifact-availability.ts";
import { deleteContainedArtifactFile } from "../storage/artifact-deletion.ts";
import type { Database } from "./database.ts";
import {
  artifactAccessGrants,
  artifacts,
  hlsPackages,
  jobs,
  organizationMemberships,
  organizations,
} from "./schema.ts";
import {
  authorizeOrganization,
  type OrganizationActor,
} from "../organizations/organization-access.ts";
import { OrganizationError } from "../organizations/organization-errors.ts";

export class ArtifactUnavailable extends Schema.TaggedErrorClass<ArtifactUnavailable>()(
  "ArtifactUnavailable",
  { reason: Schema.Literals(["invalid", "expired", "deleted"]) },
) {}

export class ArtifactRepositoryError extends Schema.TaggedErrorClass<ArtifactRepositoryError>()(
  "ArtifactRepositoryError",
  { cause: Schema.Defect(), operation: Schema.String },
) {}

interface OwnedArtifactInput extends OrganizationActor {
  readonly artifactId: string;
  readonly organizationId: string;
}

interface AuthorizeArtifactInput extends OwnedArtifactInput {
  readonly accessTtlMs: number;
  readonly now: number;
}

export const findOwnedArtifact = Effect.fn("ArtifactControlRepository.findOwned")(function* (
  database: Database,
  input: OwnedArtifactInput,
) {
  return yield* tryArtifactControlRepository("find-owned", () => {
    authorizeOrganization(database.db, input, "media-read");
    return selectOwnedArtifact(database, input);
  });
});

export const authorizeOwnedArtifact = Effect.fn("ArtifactControlRepository.authorize")(function* (
  database: Database,
  input: AuthorizeArtifactInput,
) {
  const retention = yield* findOwnedArtifact(database, input);
  if (retention === undefined) {
    return { kind: "not-found" as const };
  }
  const retainedUntil = retention.retainedUntil;
  if (artifactAvailability(retention, input.now) === "expired") return { kind: "expired" as const };
  if (retention.deletedAt !== null) return { kind: "not-found" as const };

  const access = createArtifactAccessToken(Math.min(input.now + input.accessTtlMs, retainedUntil));
  return yield* tryArtifactControlRepository("authorize", () =>
    database.db.transaction(
      (transaction) => {
        authorizeOrganization(transaction, input, "media-read");
        const artifact = transaction
          .select({ artifact: artifacts })
          .from(artifacts)
          .innerJoin(jobs, eq(artifacts.jobId, jobs.id))
          .where(
            and(
              eq(artifacts.id, input.artifactId),
              eq(jobs.organizationId, input.organizationId),
              eq(jobs.state, "succeeded"),
            ),
          )
          .get()?.artifact;
        if (artifact === undefined) return { kind: "not-found" as const };
        const currentRetention = artifact.retainedUntil;
        if (artifactAvailability(artifact, input.now) === "expired")
          return { kind: "expired" as const };
        if (artifact.deletedAt !== null) return { kind: "not-found" as const };
        const expiresAt = Math.min(access.expiresAt, currentRetention);
        transaction
          .insert(artifactAccessGrants)
          .values({
            issuingMembershipId: input.membershipId,
            artifactId: artifact.id,
            createdAt: input.now,
            expiresAt,
            id: randomUUID(),
            tokenHash: access.accessTokenHash,
          })
          .run();
        return { artifact, expiresAt, kind: "authorized" as const, token: access.token };
      },
      { behavior: "immediate" },
    ),
  );
});

export const findGrantedArtifact = Effect.fn("ArtifactControlRepository.findGranted")(function* (
  database: Database,
  input: { readonly artifactId: string; readonly now: number; readonly token: unknown },
) {
  const tokenHash = yield* artifactTokenLookupHash(input.token).pipe(
    Effect.mapError(() => new ArtifactUnavailable({ reason: "invalid" })),
  );
  const result = yield* tryArtifactControlRepository("find-granted", () =>
    database.db
      .select({ artifact: artifacts, grant: artifactAccessGrants })
      .from(artifactAccessGrants)
      .innerJoin(artifacts, eq(artifactAccessGrants.artifactId, artifacts.id))
      .innerJoin(organizations, eq(organizations.id, artifacts.organizationId))
      .innerJoin(
        organizationMemberships,
        and(
          eq(organizationMemberships.id, artifactAccessGrants.issuingMembershipId),
          eq(organizationMemberships.organizationId, artifacts.organizationId),
        ),
      )
      .where(
        and(
          eq(artifacts.id, input.artifactId),
          eq(artifactAccessGrants.tokenHash, tokenHash),
          eq(organizations.state, "active"),
        ),
      )
      .get(),
  );
  if (result === undefined) return yield* new ArtifactUnavailable({ reason: "invalid" });
  const retainedUntil = result.artifact.retainedUntil;
  yield* ensureArtifactTokenActive(Math.min(result.grant.expiresAt, retainedUntil), input.now).pipe(
    Effect.mapError(() => new ArtifactUnavailable({ reason: "expired" })),
  );
  if (result.artifact.deletedAt !== null) {
    return yield* new ArtifactUnavailable({ reason: "deleted" });
  }
  return {
    ...result.artifact,
    expiresAt: Math.min(result.grant.expiresAt, retainedUntil),
  };
});

export const tombstoneOwnedArtifact = Effect.fn("ArtifactControlRepository.tombstone")(function* (
  database: Database,
  input: OwnedArtifactInput & { readonly now: number },
) {
  return yield* tryArtifactControlRepository("tombstone", () =>
    database.db.transaction(
      (transaction) => {
        authorizeOrganization(transaction, input, "media-write");
        const artifact = transaction
          .select({ artifact: artifacts })
          .from(artifacts)
          .innerJoin(jobs, eq(artifacts.jobId, jobs.id))
          .where(
            and(
              eq(artifacts.id, input.artifactId),
              eq(jobs.organizationId, input.organizationId),
              eq(jobs.state, "succeeded"),
            ),
          )
          .get()?.artifact;
        if (artifact === undefined) return { kind: "not-found" as const };
        transaction
          .delete(artifactAccessGrants)
          .where(eq(artifactAccessGrants.artifactId, artifact.id))
          .run();
        if (artifact.deletedAt !== null) {
          return { artifact, kind: "already-deleted" as const };
        }
        const deleted = transaction
          .update(artifacts)
          .set({ deletedAt: input.now, deletionError: "pending" })
          .where(eq(artifacts.id, artifact.id))
          .returning()
          .get();
        return { artifact: deleted, kind: "tombstoned" as const };
      },
      { behavior: "immediate" },
    ),
  );
});

export const recordArtifactDeletionError = (
  database: Database,
  artifactId: string,
  deletionError: string | null,
) =>
  tryArtifactControlRepository("record-deletion-error", () =>
    database.db
      .update(artifacts)
      .set({ deletionError: deletionError?.slice(0, 100) ?? null })
      .where(eq(artifacts.id, artifactId))
      .run(),
  );

const selectOwnedArtifact = (database: Database, input: OwnedArtifactInput) =>
  database.db
    .select({ artifact: artifacts })
    .from(artifacts)
    .innerJoin(jobs, eq(artifacts.jobId, jobs.id))
    .where(
      and(
        eq(artifacts.id, input.artifactId),
        eq(jobs.organizationId, input.organizationId),
        eq(jobs.state, "succeeded"),
      ),
    )
    .get()?.artifact;

const tryArtifactControlRepository = Effect.fn("ArtifactControlRepository.try")(
  <Value>(operation: string, evaluate: () => Value) =>
    Effect.try({
      catch: (cause) =>
        cause instanceof OrganizationError
          ? cause
          : new ArtifactRepositoryError({ cause, operation }),
      try: evaluate,
    }),
);

export const removeArtifactBytes = Effect.fn("ArtifactRepository.removeBytes")(function* (
  database: Database,
  artifact: typeof artifacts.$inferSelect,
  mediaRoot: string,
) {
  if (artifactHasStorageReader(database, artifact.id)) {
    yield* recordArtifactDeletionError(database, artifact.id, "storage-reader-active");
    return;
  }
  const hls = database.db
    .select()
    .from(hlsPackages)
    .where(eq(hlsPackages.artifactId, artifact.id))
    .get();
  if (hls)
    yield* deleteContainedArtifactFile(mediaRoot, hls.directory, true).pipe(
      Effect.tapError((error) =>
        recordArtifactDeletionError(database, artifact.id, error.operation),
      ),
    );
  yield* deleteContainedArtifactFile(mediaRoot, artifact.path).pipe(
    Effect.tapError((error) => recordArtifactDeletionError(database, artifact.id, error.operation)),
  );
  yield* recordArtifactDeletionError(database, artifact.id, null);
});

export const cleanupExpiredArtifacts = Effect.fn("ArtifactRepository.cleanup")(function* (
  database: Database,
  input: { readonly mediaRoot: string; readonly now: number },
) {
  yield* tryArtifactControlRepository("expire-grants", () =>
    database.db
      .delete(artifactAccessGrants)
      .where(lte(artifactAccessGrants.expiresAt, input.now))
      .run(),
  );
  return yield* runMaintenancePages(
    ({ afterId, limit }) =>
      tryArtifactControlRepository("artifact-cleanup-candidates", () =>
        database.db
          .select()
          .from(artifacts)
          .where(
            and(
              afterId === undefined ? undefined : gt(artifacts.id, afterId),
              or(
                and(lte(artifacts.retainedUntil, input.now), isNull(artifacts.deletedAt)),
                and(isNotNull(artifacts.deletedAt), isNotNull(artifacts.deletionError)),
              ),
            ),
          )
          .orderBy(asc(artifacts.id))
          .limit(limit)
          .all(),
      ),
    (artifact) => cleanupOneArtifact(database, artifact, input),
    "Artifact cleanup",
  );
});

const cleanupOneArtifact = Effect.fn("ArtifactRepository.cleanupOne")(function* (
  database: Database,
  artifact: typeof artifacts.$inferSelect,
  input: { readonly mediaRoot: string; readonly now: number },
) {
  yield* tryArtifactControlRepository("mark-cleanup-pending", () =>
    database.db.transaction(
      (transaction) => {
        transaction
          .update(artifacts)
          .set({ deletedAt: artifact.deletedAt ?? input.now, deletionError: "pending" })
          .where(eq(artifacts.id, artifact.id))
          .run();
        transaction
          .delete(artifactAccessGrants)
          .where(eq(artifactAccessGrants.artifactId, artifact.id))
          .run();
      },
      { behavior: "immediate" },
    ),
  );
  yield* removeArtifactBytes(database, artifact, input.mediaRoot);
});
