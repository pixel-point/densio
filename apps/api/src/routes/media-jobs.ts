import {
  JobEventPageSchema,
  JobListQuerySchema,
  JobListResponseSchema,
  JobLookupQuerySchema,
  JobStatusSchema,
  successEnvelope,
} from "@densio/shared";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";

import type { AuthService } from "../auth/auth-service.ts";
import type { OrganizationService } from "../organizations/organization-service.ts";
import {
  organizationRouteActor,
  organizationPathParameter,
  organizationReadErrors,
} from "./organization-route-support.ts";
import { organizationProblemDescriptor } from "./problems/organization-problems.ts";
import {
  internalErrorProblemDescriptor,
  invalidRequestProblemDescriptor,
} from "../errors/problem-details.ts";
import type { makeJobService } from "../jobs/job-service.ts";
import { InvalidJobListCursor } from "../database/job-query-repository.ts";
import {
  beginRequest,
  invalidRequestProblem,
  runRouteEffect,
  successEnvelopeInput,
} from "./route-support.ts";
import {
  bearerSecurity,
  pathParameter,
  problemResponses,
  queryParameters,
  successResponse,
} from "./openapi-support.ts";
import { authRequiredProblemDescriptor } from "./problems/auth-problems.ts";
import { jobNotFoundProblemDescriptor } from "./problems/job-problems.ts";

const decodeStatusEnvelope = Schema.decodeUnknownSync(successEnvelope(JobStatusSchema));
const decodeJobListEnvelope = Schema.decodeUnknownSync(successEnvelope(JobListResponseSchema));
const decodeJobEventPageEnvelope = Schema.decodeUnknownSync(successEnvelope(JobEventPageSchema));
const JobEventQuerySchema = Schema.Struct({
  after: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
const statusDocumentation = describeRoute({
  description:
    "Returns sourceId, executionPlanId, and structured progress (phase, percent, attempt, revision). Jobs begin preparing, then pass through queued, analyzing, processing, and publishing before succeeding; they can also fail or be canceled. Every terminal state includes an immutable receipt with intent, source facts, billing, and any execution evidence. Succeeded jobs include stable result artifact IDs and a separate live artifacts inventory. Artifact deletion or expiry does not rewrite the receipt or change a succeeded job's state.",
  operationId: "getJobStatus",
  parameters: [organizationPathParameter, pathParameter("id", "Job identifier.")],
  responses: {
    "200": successResponse("The current job state and result, when available.", JobStatusSchema),
    ...problemResponses(
      authRequiredProblemDescriptor,
      ...organizationReadErrors.map(organizationProblemDescriptor),
      jobNotFoundProblemDescriptor,
      internalErrorProblemDescriptor,
    ),
  },
  security: bearerSecurity,
  summary: "Get job status",
  tags: ["Media jobs"],
});
const listDocumentation = describeRoute({
  description:
    "Lists owned job summaries newest first with a stable ID tie-breaker. Filters are combined. Pass nextCursor as cursor with the same filters to resume; no nextCursor means the current listing is exhausted. Fetch a job's status for its full result and terminal receipt.",
  operationId: "listJobs",
  parameters: [
    organizationPathParameter,
    ...queryParameters(JobListQuerySchema, {
      state: "Filter by exact job state.",
      workflow: "Filter by exact media workflow.",
      since:
        "Include jobs created at or after this UTC timestamp, for example 2026-09-04T00:00:00Z.",
      clientReference: "Filter by exact printable client reference.",
      idempotencyKey: "Filter by exact printable execution idempotency key.",
      limit: "Page size; defaults to 25.",
      cursor: "Opaque nextCursor from the previous page. Keep the same filters.",
    }),
  ],
  responses: {
    "200": successResponse("An organization-scoped page of job summaries.", JobListResponseSchema),
    ...problemResponses(
      invalidRequestProblemDescriptor,
      authRequiredProblemDescriptor,
      ...organizationReadErrors.map(organizationProblemDescriptor),
      internalErrorProblemDescriptor,
    ),
  },
  security: bearerSecurity,
  summary: "List jobs",
  tags: ["Media jobs"],
});
const lookupDocumentation = describeRoute({
  description:
    "Recover a submitted job after losing its response. Provide exactly one of clientReference or idempotencyKey; supplying neither or both returns 400. Both keys are scoped to the selected organization. The idempotencyKey is the execution key, not a source-creation or plan-creation key.",
  operationId: "lookupJob",
  parameters: [
    organizationPathParameter,
    ...queryParameters(JobLookupQuerySchema, {
      clientReference:
        "Exact organization-unique printable client reference; mutually exclusive with idempotencyKey.",
      idempotencyKey:
        "Exact organization-scoped printable execution key; mutually exclusive with clientReference.",
    }),
  ],
  responses: {
    "200": successResponse("The recovered full job status.", JobStatusSchema),
    ...problemResponses(
      invalidRequestProblemDescriptor,
      authRequiredProblemDescriptor,
      ...organizationReadErrors.map(organizationProblemDescriptor),
      jobNotFoundProblemDescriptor,
      internalErrorProblemDescriptor,
    ),
  },
  security: bearerSecurity,
  summary: "Look up a job",
  tags: ["Media jobs"],
});
const eventsDocumentation = describeRoute({
  description:
    "Returns a finite JSON page of durable events in increasing sequence order, not an SSE stream. Pass nextCursor as after on the next poll. The cursor is exclusive and unchanged for an empty page; an empty page does not imply job completion. Inspect job state to determine completion. Event attempt and progress revision support reconnecting without confusing worker retries.",
  operationId: "listJobEvents",
  parameters: [
    organizationPathParameter,
    pathParameter("id", "Job identifier."),
    ...queryParameters(JobEventQuerySchema, {
      after: "Return events with a sequence greater than this cursor; defaults to 0.",
      limit: "Page size; defaults to 100.",
    }),
  ],
  responses: {
    "200": successResponse("A finite ordered page of durable job events.", JobEventPageSchema),
    ...problemResponses(
      invalidRequestProblemDescriptor,
      authRequiredProblemDescriptor,
      ...organizationReadErrors.map(organizationProblemDescriptor),
      jobNotFoundProblemDescriptor,
      internalErrorProblemDescriptor,
    ),
  },
  security: bearerSecurity,
  summary: "List job events",
  tags: ["Media jobs"],
});
const cancellationDocumentation = describeRoute({
  description:
    "Requests cancellation of an owned job. Work that has not started can become canceled immediately; running work observes cancellation through the worker. Poll status until terminal. Repeating cancellation is safe, and an already-terminal job is returned unchanged.",
  operationId: "cancelJob",
  parameters: [organizationPathParameter, pathParameter("id", "Job identifier.")],
  responses: {
    "200": successResponse("The updated job state.", JobStatusSchema),
    ...problemResponses(
      authRequiredProblemDescriptor,
      ...organizationReadErrors.map(organizationProblemDescriptor),
      jobNotFoundProblemDescriptor,
      internalErrorProblemDescriptor,
    ),
  },
  security: bearerSecurity,
  summary: "Cancel a job",
  tags: ["Media jobs"],
});
export interface MediaJobRouteDependencies {
  readonly organizationService: OrganizationService;
  readonly authService: AuthService["Service"];
  readonly createCorrelationId: () => string;
  readonly jobService: ReturnType<typeof makeJobService>;
  readonly now: () => number;
}

export const createMediaJobRoutes = (dependencies: MediaJobRouteDependencies) => {
  const routes = new Hono();
  ["/v1/organizations/:organizationId/jobs", "/v1/organizations/:organizationId/jobs/*"].forEach(
    (path) =>
      routes.use(path, async (context, next) => {
        context.header("cache-control", "no-store");
        await next();
      }),
  );
  registerListRoute(routes, dependencies);
  registerLookupRoute(routes, dependencies);
  registerEventsRoute(routes, dependencies);
  registerStatusRoute(routes, dependencies);
  registerCancellationRoute(routes, dependencies);
  return routes;
};

const registerListRoute = (routes: Hono, dependencies: MediaJobRouteDependencies) => {
  routes.get("/v1/organizations/:organizationId/jobs", listDocumentation, async (context) => {
    const correlationId = beginRequest(context, dependencies.createCorrelationId);

    const program = Effect.gen(function* () {
      const query = yield* decodeListQuery(context.req.query());
      const identity = yield* organizationRouteActor(context, dependencies, "media-read");
      return yield* dependencies.jobService
        .list({
          correlationId,
          limit: query.limit ?? 25,
          ...identity,
          ...(query.clientReference === undefined
            ? {}
            : { clientReference: query.clientReference }),
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          ...(query.idempotencyKey === undefined ? {} : { idempotencyKey: query.idempotencyKey }),
          ...(query.since === undefined ? {} : { since: Date.parse(query.since) }),
          ...(query.state === undefined ? {} : { state: query.state }),
          ...(query.workflow === undefined ? {} : { workflow: query.workflow }),
        })
        .pipe(
          Effect.mapError((error) =>
            error instanceof InvalidJobListCursor ? invalidRequestProblem() : error,
          ),
        );
    });
    return runRouteEffect(context, correlationId, program, (page) =>
      context.json(decodeJobListEnvelope(successEnvelopeInput(page, correlationId))),
    );
  });
};

const registerLookupRoute = (routes: Hono, dependencies: MediaJobRouteDependencies) => {
  routes.get(
    "/v1/organizations/:organizationId/jobs/lookup",
    lookupDocumentation,
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);

      const program = Effect.gen(function* () {
        const query = yield* decodeQuery(JobLookupQuerySchema, context.req.query());
        const identity = yield* organizationRouteActor(context, dependencies, "media-read");
        return yield* dependencies.jobService.lookup({
          correlationId,
          ...identity,
          ...(query.clientReference === undefined
            ? { idempotencyKey: query.idempotencyKey as string }
            : { clientReference: query.clientReference }),
        });
      });
      return runRouteEffect(context, correlationId, program, (status) =>
        context.json(decodeStatusEnvelope(successEnvelopeInput(status, correlationId))),
      );
    },
  );
};

const registerEventsRoute = (routes: Hono, dependencies: MediaJobRouteDependencies) => {
  routes.get(
    "/v1/organizations/:organizationId/jobs/:id/events",
    eventsDocumentation,
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);

      const program = Effect.gen(function* () {
        const query = yield* decodeEventQuery(context.req.query());
        const identity = yield* organizationRouteActor(context, dependencies, "media-read");
        return yield* dependencies.jobService.events({
          after: query.after ?? 0,
          jobId: context.req.param("id"),
          limit: query.limit ?? 100,
          ...identity,
        });
      });
      return runRouteEffect(context, correlationId, program, (page) =>
        context.json(decodeJobEventPageEnvelope(successEnvelopeInput(page, correlationId))),
      );
    },
  );
};

const registerStatusRoute = (routes: Hono, dependencies: MediaJobRouteDependencies) => {
  routes.get("/v1/organizations/:organizationId/jobs/:id", statusDocumentation, async (context) => {
    const correlationId = beginRequest(context, dependencies.createCorrelationId);

    const program = Effect.gen(function* () {
      const identity = yield* organizationRouteActor(context, dependencies, "media-read");
      return yield* dependencies.jobService.status({
        correlationId,
        jobId: context.req.param("id"),
        ...identity,
      });
    });
    return runRouteEffect(context, correlationId, program, (status) =>
      context.json(decodeStatusEnvelope(successEnvelopeInput(status, correlationId))),
    );
  });
};

const registerCancellationRoute = (routes: Hono, dependencies: MediaJobRouteDependencies) => {
  routes.post(
    "/v1/organizations/:organizationId/jobs/:id/cancel",
    cancellationDocumentation,
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);

      const program = Effect.gen(function* () {
        const identity = yield* organizationRouteActor(context, dependencies, "media-read");
        return yield* dependencies.jobService.cancel({
          correlationId,
          jobId: context.req.param("id"),
          now: dependencies.now(),
          ...identity,
        });
      });
      return runRouteEffect(context, correlationId, program, (status) =>
        context.json(decodeStatusEnvelope(successEnvelopeInput(status, correlationId))),
      );
    },
  );
};

const decodeQuery = Effect.fn("MediaRoutes.decodeQuery")(
  <S extends Schema.Top>(schema: S, query: unknown) =>
    Schema.decodeUnknownEffect(schema)(query).pipe(Effect.mapError(() => invalidRequestProblem())),
);

const decodeEventQuery = (query: Readonly<Record<string, string>>) =>
  decodeQuery(JobEventQuerySchema, {
    ...(query.after === undefined ? {} : { after: Number(query.after) }),
    ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
  });

const decodeListQuery = (query: Readonly<Record<string, string>>) =>
  decodeQuery(JobListQuerySchema, {
    ...query,
    ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
  });
