import {
  ArtifactAuthorizationSchema,
  ArtifactDeletedResponseSchema,
  ArtifactDescriptorSchema,
  successEnvelope,
} from "@densio/shared";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";

import {
  ArtifactControlUnavailable,
  type makeArtifactControlService,
} from "../artifacts/artifact-control-service.ts";
import type { AuthService } from "../auth/auth-service.ts";
import type { OrganizationService } from "../organizations/organization-service.ts";
import {
  organizationRouteActor,
  organizationPathParameter,
  organizationReadErrors,
} from "./organization-route-support.ts";
import { organizationProblemDescriptor } from "./problems/organization-problems.ts";
import {
  defineProblem,
  internalErrorProblemDescriptor,
  makeDescriptorProblem,
} from "../errors/problem-details.ts";
import {
  bearerSecurity,
  pathParameter,
  problemResponses,
  successResponse,
} from "./openapi-support.ts";
import { authRequiredProblemDescriptor } from "./problems/auth-problems.ts";
import { beginRequest, runRouteEffect, successEnvelopeInput } from "./route-support.ts";

const decodeDescriptorEnvelope = Schema.decodeUnknownSync(
  successEnvelope(ArtifactDescriptorSchema),
);
const decodeAuthorizationEnvelope = Schema.decodeUnknownSync(
  successEnvelope(ArtifactAuthorizationSchema),
);
const decodeDeletionEnvelope = Schema.decodeUnknownSync(
  successEnvelope(ArtifactDeletedResponseSchema),
);

export const artifactControlNotFoundProblemDescriptor = defineProblem({
  code: "ARTIFACT_NOT_FOUND",
  description:
    "The artifact does not exist for this organization, or download authorization was requested for a deleted artifact.",
  status: 404,
  title: "Artifact not found",
});

export const artifactExpiredProblemDescriptor = defineProblem({
  code: "ARTIFACT_EXPIRED",
  description: "The artifact bytes have passed their physical retention deadline.",
  status: 410,
  title: "Artifact expired",
});

const descriptorDocumentation = describeRoute({
  description:
    "Returns stable metadata and control URLs without minting a download token. Owned deleted and expired descriptors still return 200 with their current availability. retainedUntil describes byte retention, not download-token lifetime. Consult availability before authorizing a download; reading metadata does not extend retention.",
  operationId: "getArtifact",
  parameters: [organizationPathParameter, pathParameter("artifactId", "Artifact identifier.")],
  responses: {
    "200": successResponse(
      "Stable artifact descriptor, including expired and deleted artifacts.",
      ArtifactDescriptorSchema,
    ),
    ...artifactProblems(false),
  },
  security: bearerSecurity,
  summary: "Get an owned artifact",
  tags: ["Artifacts"],
});

const authorizationDocumentation = describeRoute({
  description:
    "Creates an independent short-lived download authorization without extending physical retention. Download with the returned method and URL; the URL itself is a bearer credential and must not be logged or published. Mint another grant if it expires while the artifact is still available. Expired retention returns 410; a deleted, unknown, or unowned artifact returns 404. Keep the artifact ID for future access, not the tokenized URL.",
  operationId: "authorizeArtifact",
  parameters: [organizationPathParameter, pathParameter("artifactId", "Artifact identifier.")],
  responses: {
    "201": successResponse("Independent artifact authorization.", ArtifactAuthorizationSchema),
    ...artifactProblems(true),
  },
  security: bearerSecurity,
  summary: "Authorize an artifact download",
  tags: ["Artifacts"],
});

const deletionDocumentation = describeRoute({
  description:
    "Marks the artifact deleted and revokes all outstanding download authorizations before physical byte cleanup. Returns an idempotent deletion receipt on success. A cleanup error can return 500 after access is already revoked; retrying is safe and background cleanup retries the removal. Metadata and the owning job's immutable receipt remain readable, and the succeeded job does not change state.",
  operationId: "deleteArtifact",
  parameters: [organizationPathParameter, pathParameter("artifactId", "Artifact identifier.")],
  responses: {
    "200": successResponse("Idempotent artifact deletion receipt.", ArtifactDeletedResponseSchema),
    ...artifactProblems(false),
  },
  security: bearerSecurity,
  summary: "Delete an owned artifact",
  tags: ["Artifacts"],
});

export interface ArtifactControlRouteDependencies {
  readonly artifactService: ReturnType<typeof makeArtifactControlService>;
  readonly organizationService: OrganizationService;
  readonly authService: AuthService["Service"];
  readonly createCorrelationId: () => string;
  readonly now: () => number;
}

export const createArtifactControlRoutes = (dependencies: ArtifactControlRouteDependencies) => {
  const routes = new Hono();
  routes.get(
    "/v1/organizations/:organizationId/artifacts/:artifactId",
    descriptorDocumentation,
    async (context) => {
      context.header("cache-control", "no-store");
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const now = dependencies.now();
      const program = Effect.gen(function* () {
        const identity = yield* organizationRouteActor(context, dependencies, "media-read");
        return yield* dependencies.artifactService
          .get({ artifactId: context.req.param("artifactId"), now, ...identity })
          .pipe(Effect.mapError(mapArtifactControlError));
      });
      return runRouteEffect(context, correlationId, program, (artifact) =>
        context.json(decodeDescriptorEnvelope(successEnvelopeInput(artifact, correlationId))),
      );
    },
  );
  routes.post(
    "/v1/organizations/:organizationId/artifacts/:artifactId/authorize",
    authorizationDocumentation,
    async (context) => {
      context.header("cache-control", "no-store");
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const now = dependencies.now();
      const program = Effect.gen(function* () {
        const identity = yield* organizationRouteActor(context, dependencies, "media-read");
        return yield* dependencies.artifactService
          .authorize({ artifactId: context.req.param("artifactId"), now, ...identity })
          .pipe(Effect.mapError(mapArtifactControlError));
      });
      return runRouteEffect(context, correlationId, program, (authorization) =>
        context.json(
          decodeAuthorizationEnvelope(successEnvelopeInput(authorization, correlationId)),
          201,
        ),
      );
    },
  );
  routes.delete(
    "/v1/organizations/:organizationId/artifacts/:artifactId",
    deletionDocumentation,
    async (context) => {
      context.header("cache-control", "no-store");
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const now = dependencies.now();
      const program = Effect.gen(function* () {
        const identity = yield* organizationRouteActor(context, dependencies, "media-read");
        return yield* dependencies.artifactService
          .delete({ artifactId: context.req.param("artifactId"), now, ...identity })
          .pipe(Effect.mapError(mapArtifactControlError));
      });
      return runRouteEffect(context, correlationId, program, (deletion) =>
        context.json(decodeDeletionEnvelope(successEnvelopeInput(deletion, correlationId))),
      );
    },
  );
  return routes;
};

const mapArtifactControlError = (error: unknown) => {
  if (!(error instanceof ArtifactControlUnavailable)) return error;
  if (error.reason === "expired") {
    return makeDescriptorProblem(artifactExpiredProblemDescriptor, {
      detail: "The artifact has passed its physical retention deadline.",
      retryable: false,
      suggestedAction: "Create a new media job to produce fresh artifacts.",
    });
  }
  return makeDescriptorProblem(artifactControlNotFoundProblemDescriptor, {
    detail: "The artifact does not exist or does not belong to the selected organization.",
    retryable: false,
    suggestedAction: "Check the artifact ID using the owning job status.",
  });
};

function artifactProblems(includeExpired: boolean) {
  return problemResponses(
    authRequiredProblemDescriptor,
    ...organizationReadErrors.map(organizationProblemDescriptor),
    artifactControlNotFoundProblemDescriptor,
    ...(includeExpired ? [artifactExpiredProblemDescriptor] : []),
    internalErrorProblemDescriptor,
  );
}
