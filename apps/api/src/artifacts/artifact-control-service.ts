import { ArtifactAuthorizationSchema, ArtifactDeletedResponseSchema } from "@densio/shared";
import { Effect, Schema } from "effect";

import {
  authorizeOwnedArtifact,
  findOwnedArtifact,
  removeArtifactBytes,
  tombstoneOwnedArtifact,
} from "../database/artifact-repository.ts";
import { ArtifactRepositoryError } from "../database/artifact-repository.ts";
import type { Database } from "../database/database.ts";
import { toArtifactDescriptor } from "./artifact-descriptor.ts";
import type { OrganizationActor } from "../organizations/organization-access.ts";

export class ArtifactControlUnavailable extends Schema.TaggedErrorClass<ArtifactControlUnavailable>()(
  "ArtifactControlUnavailable",
  { reason: Schema.Literals(["not-found", "expired"]) },
) {}

interface ArtifactControlConfig {
  readonly accessGrantTtlMs: number;
  readonly mediaRoot: string;
  readonly publicBaseUrl: string;
}

interface OwnedArtifactInput extends OrganizationActor {
  readonly artifactId: string;
  readonly now: number;
  readonly organizationId: string;
}

export const makeArtifactControlService = (database: Database, config: ArtifactControlConfig) => {
  const get = Effect.fn("ArtifactControlService.get")(function* (input: OwnedArtifactInput) {
    const artifact = yield* findOwnedArtifact(database, input);
    if (artifact === undefined)
      return yield* new ArtifactControlUnavailable({ reason: "not-found" });
    return yield* toArtifactDescriptor(artifact, config.publicBaseUrl, input.now);
  });

  const authorize = Effect.fn("ArtifactControlService.authorize")(function* (
    input: OwnedArtifactInput,
  ) {
    const authorization = yield* authorizeOwnedArtifact(database, {
      accessTtlMs: config.accessGrantTtlMs,
      ...input,
    });
    if (authorization.kind === "not-found") {
      return yield* new ArtifactControlUnavailable({ reason: "not-found" });
    }
    if (authorization.kind === "expired") {
      return yield* new ArtifactControlUnavailable({ reason: "expired" });
    }
    const artifact = yield* toArtifactDescriptor(
      authorization.artifact,
      config.publicBaseUrl,
      input.now,
    );
    return yield* Schema.decodeUnknownEffect(ArtifactAuthorizationSchema)({
      organizationId: input.organizationId,
      artifact,
      download: {
        expiresAt: new Date(authorization.expiresAt).toISOString(),
        method: "GET",
        url: new URL(
          `/v1/artifacts/${artifact.id}/${authorization.token}/${encodeURIComponent(artifact.filename)}`,
          config.publicBaseUrl,
        ).toString(),
      },
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ArtifactRepositoryError({ cause, operation: "decode-artifact-authorization" }),
      ),
    );
  });

  const deleteArtifact = Effect.fn("ArtifactControlService.delete")(function* (
    input: OwnedArtifactInput,
  ) {
    const owned = yield* findOwnedArtifact(database, input);
    if (owned === undefined) {
      return yield* new ArtifactControlUnavailable({ reason: "not-found" });
    }
    const deletion = yield* tombstoneOwnedArtifact(database, input);
    if (deletion.kind === "not-found") {
      return yield* new ArtifactControlUnavailable({ reason: "not-found" });
    }
    if (deletion.artifact === undefined) {
      return yield* new ArtifactRepositoryError({
        cause: "missing-tombstoned-artifact",
        operation: "delete-artifact",
      });
    }
    yield* removeArtifactBytes(database, deletion.artifact, config.mediaRoot);
    return yield* Schema.decodeUnknownEffect(ArtifactDeletedResponseSchema)({
      organizationId: input.organizationId,
      artifactId: deletion.artifact.id,
      deleted: true,
      deletedAt: new Date(deletion.artifact.deletedAt ?? input.now).toISOString(),
    }).pipe(
      Effect.mapError(
        (cause) => new ArtifactRepositoryError({ cause, operation: "decode-artifact-deletion" }),
      ),
    );
  });

  return { authorize, delete: deleteArtifact, get };
};
