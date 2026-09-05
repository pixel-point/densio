import {
  DefaultOrganizationRequestSchema,
  OrganizationCreateRequestSchema,
  OrganizationCreateResponseSchema,
  OrganizationListQuerySchema,
  OrganizationListResponseSchema,
  OrganizationMembershipSchema,
  OrganizationRenameRequestSchema,
  OrganizationSchema,
  JobIdempotencyKeySchema,
} from "@densio/shared";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import {
  authenticateRequest,
  beginRequest,
  decodeRequestJson,
  invalidRequestProblem,
  requireHeader,
  runRouteEffect,
} from "./route-support.ts";
import {
  organizationPathParameter,
  organizationQuery,
  organizationReadErrors,
  organizationResponse,
  organizationRouteActor,
  organizationRouteDocumentation,
  type OrganizationRouteDependencies,
} from "./organization-route-support.ts";
import { registerOrganizationMemberRoutes } from "./organization-members.ts";
import { headerParameter } from "./openapi-support.ts";

export type { OrganizationRouteDependencies } from "./organization-route-support.ts";

export const createOrganizationRoutes = (dependencies: OrganizationRouteDependencies) => {
  const routes = new Hono();
  registerDirectory(routes, dependencies);
  registerCreation(routes, dependencies);
  registerOrganizationMetadata(routes, dependencies);
  registerDefault(routes, dependencies);
  registerOrganizationMemberRoutes(routes, dependencies);
  return routes;
};

const registerDirectory = (routes: Hono, dependencies: OrganizationRouteDependencies) => {
  routes.get(
    "/v1/organizations",
    organizationRouteDocumentation({
      operationId: "listOrganizations",
      summary: "List your organization memberships",
      response: OrganizationListResponseSchema,
      query: OrganizationListQuerySchema,
    }),
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const program = Effect.gen(function* () {
        const identity = yield* authenticateRequest(
          context.req.raw,
          dependencies.authService,
          dependencies.now(),
        );
        const query = yield* organizationQuery(context, OrganizationListQuerySchema);
        return yield* dependencies.organizationService.list({ ...query, userId: identity.userId });
      });
      return runRouteEffect(context, correlationId, program, (value) =>
        organizationResponse(context, OrganizationListResponseSchema, value, correlationId),
      );
    },
  );
};

const registerCreation = (routes: Hono, dependencies: OrganizationRouteDependencies) => {
  routes.post(
    "/v1/organizations",
    organizationRouteDocumentation({
      operationId: "createOrganization",
      summary: "Create an organization without changing your default",
      request: OrganizationCreateRequestSchema,
      response: OrganizationCreateResponseSchema,
      created: true,
      parameters: [
        headerParameter(
          "idempotency-key",
          "Required creator-scoped retry key.",
          true,
          JobIdempotencyKeySchema,
        ),
      ],
      errors: [
        "ORGANIZATION_NOT_FOUND",
        "ORGANIZATION_NOT_ACTIVE",
        "IDEMPOTENCY_CONFLICT",
        "ORGANIZATION_RATE_LIMITED",
      ],
    }),
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const program = Effect.gen(function* () {
        const identity = yield* authenticateRequest(
          context.req.raw,
          dependencies.authService,
          dependencies.now(),
        );
        const input = yield* decodeRequestJson(context.req.raw, OrganizationCreateRequestSchema);
        const idempotencyKey = yield* requireHeader(context.req.header("idempotency-key")).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(JobIdempotencyKeySchema)),
          Effect.mapError(() => invalidRequestProblem()),
        );
        return yield* dependencies.organizationService.create({
          ...input,
          userId: identity.userId,
          idempotencyKey,
          now: dependencies.now(),
          correlationId,
          maxCreatesPerDay: dependencies.maxCreatesPerDay,
        });
      });
      return runRouteEffect(context, correlationId, program, (value) =>
        organizationResponse(
          context,
          OrganizationCreateResponseSchema,
          value,
          correlationId,
          value.replayed ? 200 : 201,
        ),
      );
    },
  );
};

const registerOrganizationMetadata = (
  routes: Hono,
  dependencies: OrganizationRouteDependencies,
) => {
  routes.get(
    "/v1/organizations/:organizationId",
    organizationRouteDocumentation({
      operationId: "getOrganization",
      summary: "Read an organization or its closure status",
      response: OrganizationMembershipSchema,
      parameters: [organizationPathParameter],
      errors: ["ORGANIZATION_NOT_FOUND"],
    }),
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const program = Effect.gen(function* () {
        const identity = yield* authenticateRequest(
          context.req.raw,
          dependencies.authService,
          dependencies.now(),
        );
        return yield* dependencies.organizationService.get({
          organizationId: context.req.param("organizationId"),
          userId: identity.userId,
        });
      });
      return runRouteEffect(context, correlationId, program, (value) =>
        organizationResponse(context, OrganizationMembershipSchema, value, correlationId),
      );
    },
  );
  routes.patch(
    "/v1/organizations/:organizationId",
    organizationRouteDocumentation({
      operationId: "renameOrganization",
      summary: "Rename an organization as owner or admin",
      request: OrganizationRenameRequestSchema,
      response: OrganizationSchema,
      parameters: [organizationPathParameter],
      errors: organizationReadErrors,
    }),
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const program = Effect.gen(function* () {
        const actor = yield* organizationRouteActor(context, dependencies, "organization-rename");
        const input = yield* decodeRequestJson(context.req.raw, OrganizationRenameRequestSchema);
        return yield* dependencies.organizationService.rename({
          ...input,
          actor,
          now: dependencies.now(),
          correlationId,
        });
      });
      return runRouteEffect(context, correlationId, program, (value) =>
        organizationResponse(context, OrganizationSchema, value, correlationId),
      );
    },
  );
};

const registerDefault = (routes: Hono, dependencies: OrganizationRouteDependencies) => {
  routes.put(
    "/v1/auth/default-organization",
    organizationRouteDocumentation({
      operationId: "setDefaultOrganization",
      summary: "Explicitly set your server-side default organization",
      request: DefaultOrganizationRequestSchema,
      response: DefaultOrganizationRequestSchema,
      errors: ["ORGANIZATION_NOT_FOUND", "ORGANIZATION_NOT_ACTIVE"],
    }),
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const program = Effect.gen(function* () {
        const identity = yield* authenticateRequest(
          context.req.raw,
          dependencies.authService,
          dependencies.now(),
        );
        const input = yield* decodeRequestJson(context.req.raw, DefaultOrganizationRequestSchema);
        return yield* dependencies.organizationService.setDefault({
          ...input,
          userId: identity.userId,
          now: dependencies.now(),
          correlationId,
        });
      });
      return runRouteEffect(context, correlationId, program, (value) =>
        organizationResponse(context, DefaultOrganizationRequestSchema, value, correlationId),
      );
    },
  );
};
