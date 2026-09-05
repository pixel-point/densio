import {
  OrganizationInvitationAcceptResponseSchema,
  OrganizationInvitationCreateRequestSchema,
  OrganizationInvitationListQuerySchema,
  OrganizationInvitationSchema,
  OrganizationInvitationsResponseSchema,
  ReceivedInvitationsResponseSchema,
} from "@densio/shared";
import { Effect } from "effect";
import { Hono } from "hono";
import type { OrganizationInvitationService } from "../organizations/organization-invitation-service.ts";
import {
  authenticateRequest,
  beginRequest,
  decodeRequestJson,
  runRouteEffect,
} from "./route-support.ts";
import { pathParameter } from "./openapi-support.ts";
import {
  organizationPathParameter,
  organizationQuery,
  organizationReadErrors,
  organizationResponse,
  organizationRouteActor,
  organizationRouteDocumentation,
  type OrganizationRouteDependencies,
} from "./organization-route-support.ts";

export interface OrganizationInvitationRouteDependencies extends OrganizationRouteDependencies {
  readonly invitationService: OrganizationInvitationService;
  readonly maxInvitationsPerHour: number;
}
const base = "/v1/organizations/:organizationId/invitations";
const invitationIdParameter = pathParameter(
  "invitationId",
  "Email-addressed invitation ID; not a bearer credential.",
);

export const createOrganizationInvitationRoutes = (
  dependencies: OrganizationInvitationRouteDependencies,
) => {
  const routes = new Hono();
  registerRecipientRoutes(routes, dependencies);
  registerOrganizationList(routes, dependencies);
  registerCreate(routes, dependencies);
  registerRevoke(routes, dependencies);
  return routes;
};

const registerRecipientRoutes = (
  routes: Hono,
  dependencies: OrganizationInvitationRouteDependencies,
) => {
  routes.get(
    "/v1/organization-invitations",
    organizationRouteDocumentation({
      operationId: "listReceivedInvitations",
      summary: "List invitations addressed to your verified email",
      response: ReceivedInvitationsResponseSchema,
      query: OrganizationInvitationListQuerySchema,
    }),
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const program = Effect.gen(function* () {
        const identity = yield* authenticateRequest(
          context.req.raw,
          dependencies.authService,
          dependencies.now(),
        );
        const query = yield* organizationQuery(context, OrganizationInvitationListQuerySchema);
        return yield* dependencies.invitationService.received({
          ...query,
          userId: identity.userId,
          now: dependencies.now(),
        });
      });
      return runRouteEffect(context, correlationId, program, (value) =>
        organizationResponse(context, ReceivedInvitationsResponseSchema, value, correlationId),
      );
    },
  );
  routes.post(
    "/v1/organization-invitations/:invitationId/accept",
    organizationRouteDocumentation({
      operationId: "acceptOrganizationInvitation",
      summary: "Accept an invitation without changing your default organization",
      response: OrganizationInvitationAcceptResponseSchema,
      parameters: [invitationIdParameter],
      errors: [
        "ORGANIZATION_INVITATION_NOT_FOUND",
        "ORGANIZATION_INVITATION_EXPIRED",
        "ORGANIZATION_INVITATION_UNAVAILABLE",
        "ORGANIZATION_INVITATION_CONFLICT",
        "ORGANIZATION_NOT_ACTIVE",
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
        return yield* dependencies.invitationService.accept({
          invitationId: context.req.param("invitationId"),
          userId: identity.userId,
          now: dependencies.now(),
          correlationId,
        });
      });
      return runRouteEffect(context, correlationId, program, (value) =>
        organizationResponse(
          context,
          OrganizationInvitationAcceptResponseSchema,
          value,
          correlationId,
        ),
      );
    },
  );
};

const registerOrganizationList = (
  routes: Hono,
  dependencies: OrganizationInvitationRouteDependencies,
) => {
  routes.get(
    base,
    organizationRouteDocumentation({
      operationId: "listOrganizationInvitations",
      summary: "List organization invitations as owner or admin",
      response: OrganizationInvitationsResponseSchema,
      query: OrganizationInvitationListQuerySchema,
      parameters: [organizationPathParameter],
      errors: organizationReadErrors,
    }),
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const program = Effect.gen(function* () {
        const actor = yield* organizationRouteActor(context, dependencies, "invitations-read");
        const query = yield* organizationQuery(context, OrganizationInvitationListQuerySchema);
        return yield* dependencies.invitationService.list({
          ...query,
          actor,
          now: dependencies.now(),
        });
      });
      return runRouteEffect(context, correlationId, program, (value) =>
        organizationResponse(context, OrganizationInvitationsResponseSchema, value, correlationId),
      );
    },
  );
};

const registerCreate = (routes: Hono, dependencies: OrganizationInvitationRouteDependencies) => {
  routes.post(
    base,
    organizationRouteDocumentation({
      operationId: "createOrganizationInvitation",
      summary: "Invite a verified-email recipient, or recover an equivalent pending invitation",
      request: OrganizationInvitationCreateRequestSchema,
      response: OrganizationInvitationSchema,
      parameters: [organizationPathParameter],
      errors: [
        ...organizationReadErrors,
        "ORGANIZATION_OWNER_REQUIRED",
        "ORGANIZATION_INVITATION_CONFLICT",
        "ORGANIZATION_RATE_LIMITED",
      ],
    }),
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const program = Effect.gen(function* () {
        const actor = yield* organizationRouteActor(context, dependencies, "members-manage");
        const input = yield* decodeRequestJson(
          context.req.raw,
          OrganizationInvitationCreateRequestSchema,
        );
        return yield* dependencies.invitationService.create({
          ...input,
          actor,
          now: dependencies.now(),
          correlationId,
          maxInvitationsPerHour: dependencies.maxInvitationsPerHour,
        });
      });
      return runRouteEffect(context, correlationId, program, (value) =>
        organizationResponse(context, OrganizationInvitationSchema, value, correlationId),
      );
    },
  );
};

const registerRevoke = (routes: Hono, dependencies: OrganizationInvitationRouteDependencies) => {
  routes.delete(
    `${base}/:invitationId`,
    organizationRouteDocumentation({
      operationId: "revokeOrganizationInvitation",
      summary: "Revoke an unaccepted organization invitation",
      response: OrganizationInvitationSchema,
      parameters: [organizationPathParameter, invitationIdParameter],
      errors: [
        ...organizationReadErrors,
        "ORGANIZATION_OWNER_REQUIRED",
        "ORGANIZATION_INVITATION_NOT_FOUND",
        "ORGANIZATION_INVITATION_CONFLICT",
      ],
    }),
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const program = Effect.gen(function* () {
        const actor = yield* organizationRouteActor(context, dependencies, "members-manage");
        return yield* dependencies.invitationService.revoke({
          actor,
          invitationId: context.req.param("invitationId"),
          now: dependencies.now(),
          correlationId,
        });
      });
      return runRouteEffect(context, correlationId, program, (value) =>
        organizationResponse(context, OrganizationInvitationSchema, value, correlationId),
      );
    },
  );
};
