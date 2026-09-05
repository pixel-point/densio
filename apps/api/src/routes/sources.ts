import type { makeSourceUploadService } from "../storage/uploads/source-upload-service.ts";
import { storageFailure } from "../storage/storage-errors.ts";
import {
  JobIdempotencyKeySchema,
  PLAN_CATALOG,
  PreparedSourceCreateRequestSchema,
  PreparedSourceCreateResponseSchema,
  PreparedSourceDeletionReceiptSchema,
  PreparedSourceStatusSchema,
  PreparedSourceListQuerySchema,
  PreparedSourceListResponseSchema,
  successEnvelope,
} from "@densio/shared";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";

import type { AuthService } from "../auth/auth-service.ts";
import { InvalidSourceListCursor } from "../database/source-query-repository.ts";
import type { BillingPriceIds } from "../billing/billing-repository.ts";
import type { BillingService } from "../billing/billing-service.ts";
import {
  type ApiProblem,
  internalErrorProblemDescriptor,
  invalidRequestProblemDescriptor,
  requestTooLargeProblemDescriptor,
} from "../errors/problem-details.ts";
import type { makePreparedSourceService } from "../sources/prepared-source-service.ts";
import {
  beginRequest,
  decodeRequestJson,
  invalidRequestProblem,
  runRouteEffect,
  successEnvelopeInput,
} from "./route-support.ts";
import {
  bearerSecurity,
  binaryBody,
  headerParameter,
  jsonRequest,
  pathParameter,
  problemResponses,
  queryParameters,
  successResponse,
} from "./openapi-support.ts";
import { authRequiredProblemDescriptor } from "./problems/auth-problems.ts";
import type { OrganizationService } from "../organizations/organization-service.ts";
import {
  organizationRouteActor,
  organizationPathParameter,
  organizationReadErrors,
} from "./organization-route-support.ts";
import { organizationProblemDescriptor } from "./problems/organization-problems.ts";
import {
  sourceIdempotencyProblemDescriptor,
  sourceNotFoundProblemDescriptor,
  sourceProblem,
  sourceStateProblemDescriptor,
  sourceUploadExpiredProblemDescriptor,
  sourceUploadLimitProblemDescriptor,
  sourceUploadSizeProblemDescriptor,
} from "./problems/source-problems.ts";

const decodeIdempotencyKey = Schema.decodeUnknownEffect(JobIdempotencyKeySchema);
const decodeCreateEnvelope = Schema.decodeUnknownSync(
  successEnvelope(PreparedSourceCreateResponseSchema),
);
const decodeStatusEnvelope = Schema.decodeUnknownSync(successEnvelope(PreparedSourceStatusSchema));
const decodeDeletionEnvelope = Schema.decodeUnknownSync(
  successEnvelope(PreparedSourceDeletionReceiptSchema),
);

const createDocumentation = describeRoute({
  description:
    "Declares a reusable source without creating a job. Supply the safe filename and exact byte count, then PUT raw media to the returned upload action before its expiresAt deadline. The source must reach ready before planning. Reuse an optional idempotency key with the same declaration to recover the existing source and its current state.",
  operationId: "createPreparedSource",
  parameters: [
    organizationPathParameter,
    headerParameter(
      "idempotency-key",
      "Optional retry key. Reusing it with a different declaration returns a conflict.",
      false,
      JobIdempotencyKeySchema,
    ),
  ],
  requestBody: jsonRequest(PreparedSourceCreateRequestSchema, {
    upload: {
      summary: "Declare a local video (replace bytes with its exact file size)",
      value: { filename: "input.mp4", bytes: 1048576 },
    },
  }),
  responses: {
    "200": successResponse(
      "An idempotent retry returned its existing source.",
      PreparedSourceCreateResponseSchema,
    ),
    "201": successResponse("The prepared source was created.", PreparedSourceCreateResponseSchema),
    ...problemResponses(
      invalidRequestProblemDescriptor,
      authRequiredProblemDescriptor,
      ...organizationReadErrors.map(organizationProblemDescriptor),
      sourceIdempotencyProblemDescriptor,
      requestTooLargeProblemDescriptor,
      sourceUploadLimitProblemDescriptor,
      internalErrorProblemDescriptor,
    ),
  },
  security: bearerSecurity,
  summary: "Create a prepared source",
  tags: ["Prepared sources"],
});

const uploadDocumentation = describeRoute({
  description:
    "Send raw application/octet-stream bytes, not multipart form data, with bearer authentication. The API verifies the declared byte count, hashes and inspects the media, and returns its durable source state. A 200 response can contain state failed with a problem: require ready before creating a plan. During recovery, GET the source to observe finalizing or inspecting. Upload actions are available only while awaiting-upload and disappear after acceptance.",
  operationId: "uploadPreparedSource",
  parameters: [organizationPathParameter, pathParameter("id", "Prepared source identifier.")],
  requestBody: binaryBody,
  responses: {
    "200": successResponse(
      "The upload was inspected or reached a durable failed state.",
      PreparedSourceStatusSchema,
    ),
    ...problemResponses(
      invalidRequestProblemDescriptor,
      authRequiredProblemDescriptor,
      ...organizationReadErrors.map(organizationProblemDescriptor),
      sourceNotFoundProblemDescriptor,
      sourceStateProblemDescriptor,
      sourceUploadExpiredProblemDescriptor,
      sourceUploadLimitProblemDescriptor,
      sourceUploadSizeProblemDescriptor,
      internalErrorProblemDescriptor,
    ),
  },
  security: bearerSecurity,
  summary: "Upload and inspect prepared source media",
  tags: ["Prepared sources"],
});

const statusDocumentation = describeRoute({
  description:
    "Returns the current owned source state, inspection when ready, or its failure problem. Deleted and expired sources remain readable as history, without an upload action. Source retention is independent of job and output retention.",
  operationId: "getPreparedSource",
  parameters: [organizationPathParameter, pathParameter("id", "Prepared source identifier.")],
  responses: {
    "200": successResponse("The current prepared source state.", PreparedSourceStatusSchema),
    ...problemResponses(
      authRequiredProblemDescriptor,
      ...organizationReadErrors.map(organizationProblemDescriptor),
      sourceNotFoundProblemDescriptor,
      internalErrorProblemDescriptor,
    ),
  },
  security: bearerSecurity,
  summary: "Get prepared source status",
  tags: ["Prepared sources"],
});

const deletionDocumentation = describeRoute({
  description:
    "Marks the source deleted and prevents future planning or input attachment before physical cleanup. The source remains visible in GET and list history. Deletion does not remove already-attached job inputs or outputs. A cleanup error can return 500 after the source is already deleted; retrying is safe and background maintenance retries remaining cleanup.",
  operationId: "deletePreparedSource",
  parameters: [organizationPathParameter, pathParameter("id", "Prepared source identifier.")],
  responses: {
    "200": successResponse(
      "Idempotent source deletion receipt; the source remains in history as deleted.",
      PreparedSourceDeletionReceiptSchema,
    ),
    ...problemResponses(
      authRequiredProblemDescriptor,
      ...organizationReadErrors.map(organizationProblemDescriptor),
      sourceNotFoundProblemDescriptor,
      internalErrorProblemDescriptor,
    ),
  },
  security: bearerSecurity,
  summary: "Delete a prepared source",
  tags: ["Prepared sources"],
});

export interface SourceRouteDependencies {
  readonly sourceUploads?: ReturnType<typeof makeSourceUploadService>;
  readonly organizationService: OrganizationService;
  readonly authService: AuthService["Service"];
  readonly billingService: BillingService["Service"];
  readonly createCorrelationId: () => string;
  readonly maxUploadBytes: number;
  readonly now: () => number;
  readonly priceIds: BillingPriceIds;
  readonly sourceService: ReturnType<typeof makePreparedSourceService>;
}

export const createSourceRoutes = (dependencies: SourceRouteDependencies) => {
  const routes = new Hono();
  registerListRoute(routes, dependencies);
  registerCreateRoute(routes, dependencies);
  registerUploadRoute(routes, dependencies);
  registerStatusRoute(routes, dependencies);
  registerDeletionRoute(routes, dependencies);
  return routes;
};

const registerListRoute = (routes: Hono, dependencies: SourceRouteDependencies) => {
  routes.get(
    "/v1/organizations/:organizationId/sources",
    describeRoute({
      description:
        "Lists only the selected organization's sources, including deleted and expired history, newest first with a stable ID tie-breaker. Keep filters unchanged when passing nextCursor as cursor; no nextCursor means the current listing is exhausted.",
      operationId: "listPreparedSources",
      summary: "List uploaded sources and their history",
      tags: ["Prepared sources"],
      security: bearerSecurity,
      parameters: [
        organizationPathParameter,
        ...queryParameters(PreparedSourceListQuerySchema, {
          state: "Exact source state.",
          since: "Inclusive UTC creation timestamp, for example 2026-09-04T00:00:00Z.",
          limit: "Page size; defaults to 25.",
          cursor: "Opaque nextCursor from the previous page. Keep the same filters.",
        }),
      ],
      responses: {
        "200": successResponse(
          "An organization-scoped source page.",
          PreparedSourceListResponseSchema,
        ),
        ...problemResponses(
          invalidRequestProblemDescriptor,
          authRequiredProblemDescriptor,
          ...organizationReadErrors.map(organizationProblemDescriptor),
          internalErrorProblemDescriptor,
        ),
      },
    }),
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const now = dependencies.now();
      const program = Effect.gen(function* () {
        const identity = yield* organizationRouteActor(context, dependencies, "media-write");
        const query = context.req.query();
        const filters = yield* Schema.decodeUnknownEffect(PreparedSourceListQuerySchema, {
          onExcessProperty: "error",
        })({
          ...query,
          ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
        }).pipe(Effect.mapError(() => invalidRequestProblem()));
        return yield* dependencies.sourceService.list({
          ...filters,
          correlationId,
          now,
          ...identity,
        });
      }).pipe(
        Effect.mapError((error) =>
          error instanceof InvalidSourceListCursor ? invalidRequestProblem() : error,
        ),
        mapSourceProblems,
      );
      return runRouteEffect(context, correlationId, program, (page) =>
        context.json(
          Schema.decodeUnknownSync(successEnvelope(PreparedSourceListResponseSchema))(
            successEnvelopeInput(page, correlationId),
          ),
        ),
      );
    },
  );
};

const registerCreateRoute = (routes: Hono, dependencies: SourceRouteDependencies) => {
  routes.post("/v1/organizations/:organizationId/sources", createDocumentation, async (context) => {
    const correlationId = beginRequest(context, dependencies.createCorrelationId);
    const now = dependencies.now();
    const program = Effect.gen(function* () {
      const request = yield* decodeRequestJson(context.req.raw, PreparedSourceCreateRequestSchema);
      const identity = yield* organizationRouteActor(context, dependencies, "media-write");
      const billing = yield* dependencies.billingService.getEntitlement({
        now,
        priceIds: dependencies.priceIds,
        ...identity,
      });
      const idempotencyKey = yield* optionalIdempotencyKey(context.req.header("idempotency-key"));
      const creator =
        request.uploadStorage === undefined
          ? dependencies.sourceService.create
          : dependencies.sourceUploads?.create;
      if (!creator) return yield* storageFailure("STORAGE_NOT_CONFIGURED");
      return yield* creator({
        ...request,
        uploadStorage: request.uploadStorage ?? "",
        correlationId,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        maxUploadBytes: Math.min(
          dependencies.maxUploadBytes,
          PLAN_CATALOG[billing.entitlements.plan].maxUploadBytes,
        ),
        now,
        ...identity,
      });
    }).pipe(mapSourceProblems);
    return runRouteEffect(context, correlationId, program, (created) =>
      context.json(
        decodeCreateEnvelope(successEnvelopeInput(created, correlationId)),
        created.replayed ? 200 : 201,
      ),
    );
  });
};

const registerUploadRoute = (routes: Hono, dependencies: SourceRouteDependencies) => {
  routes.put(
    "/v1/organizations/:organizationId/sources/:id/upload",
    uploadDocumentation,
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const now = dependencies.now();
      const program = Effect.gen(function* () {
        const identity = yield* organizationRouteActor(context, dependencies, "media-write");
        const body = context.req.raw.body;
        if (body === null) return yield* invalidRequestProblem();
        return yield* dependencies.sourceService.upload({
          body,
          correlationId,
          now,
          sourceId: context.req.param("id"),
          ...identity,
        });
      }).pipe(mapSourceProblems);
      return runRouteEffect(context, correlationId, program, (status) =>
        context.json(decodeStatusEnvelope(successEnvelopeInput(status, correlationId))),
      );
    },
  );
};

const registerStatusRoute = (routes: Hono, dependencies: SourceRouteDependencies) => {
  routes.get(
    "/v1/organizations/:organizationId/sources/:id",
    statusDocumentation,
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const now = dependencies.now();
      const program = Effect.gen(function* () {
        const identity = yield* organizationRouteActor(context, dependencies, "media-write");
        return yield* dependencies.sourceService.status({
          correlationId,
          now,
          sourceId: context.req.param("id"),
          ...identity,
        });
      }).pipe(mapSourceProblems);
      return runRouteEffect(context, correlationId, program, (status) =>
        context.json(decodeStatusEnvelope(successEnvelopeInput(status, correlationId))),
      );
    },
  );
};

const registerDeletionRoute = (routes: Hono, dependencies: SourceRouteDependencies) => {
  routes.delete(
    "/v1/organizations/:organizationId/sources/:id",
    deletionDocumentation,
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const now = dependencies.now();
      const program = Effect.gen(function* () {
        const identity = yield* organizationRouteActor(context, dependencies, "media-write");
        return yield* dependencies.sourceService.delete({
          now,
          sourceId: context.req.param("id"),
          ...identity,
        });
      }).pipe(mapSourceProblems);
      return runRouteEffect(context, correlationId, program, (receipt) =>
        context.json(decodeDeletionEnvelope(successEnvelopeInput(receipt, correlationId))),
      );
    },
  );
};

const optionalIdempotencyKey = Effect.fn("SourceRoutes.idempotencyKey")(
  (value: string | undefined) =>
    value === undefined
      ? Effect.succeed<string | undefined>(undefined)
      : decodeIdempotencyKey(value).pipe(
          Effect.map((key): string | undefined => key),
          Effect.mapError(() => invalidRequestProblem()),
        ),
);

const mapSourceProblems = <Value, Error, Requirements>(
  effect: Effect.Effect<Value, Error, Requirements>,
) => effect.pipe(Effect.mapError((error): Error | ApiProblem => sourceProblem(error) ?? error));
