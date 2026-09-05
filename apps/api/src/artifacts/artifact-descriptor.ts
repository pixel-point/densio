import { ArtifactDescriptorSchema } from "@densio/shared";
import { Effect, Schema } from "effect";
import { ArtifactRepositoryError } from "../database/artifact-repository.ts";
import type { artifacts } from "../database/schema.ts";
import { artifactAvailability } from "./artifact-availability.ts";
import { artifactFacts } from "./artifact-facts.ts";

export const toArtifactDescriptor = Effect.fn("ArtifactDescriptor.fromRow")(function* (
  artifact: typeof artifacts.$inferSelect,
  publicBaseUrl: string,
  now: number,
) {
  return yield* Schema.decodeUnknownEffect(ArtifactDescriptorSchema)({
    ...artifactFacts(artifact),
    availability: artifactAvailability(artifact, now),
    authorizeUrl: new URL(
      `/v1/organizations/${artifact.organizationId}/artifacts/${artifact.id}/authorize`,
      publicBaseUrl,
    ).toString(),
    deleteUrl: new URL(
      `/v1/organizations/${artifact.organizationId}/artifacts/${artifact.id}`,
      publicBaseUrl,
    ).toString(),
  }).pipe(
    Effect.mapError(
      (cause) => new ArtifactRepositoryError({ cause, operation: "decode-artifact-descriptor" }),
    ),
  );
});
