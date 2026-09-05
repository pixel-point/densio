import {
  OrganizationAuditPageSchema,
  OrganizationAuditQuerySchema,
  OrganizationDirectoryQuerySchema,
  OrganizationMemberRemovalSchema,
  OrganizationMemberRoleRequestSchema,
  OrganizationMemberSchema,
  OrganizationMembersResponseSchema,
  OrganizationTransferRequestSchema,
} from "@densio/shared";
import { Effect } from "effect";
import type { Hono } from "hono";
import { beginRequest, decodeRequestJson, runRouteEffect } from "./route-support.ts";
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

const base = "/v1/organizations/:organizationId";
const memberParameters = [
  organizationPathParameter,
  pathParameter("userId", "Current organization member's user ID."),
];
const mutationErrors = [
  ...organizationReadErrors,
  "ORGANIZATION_OWNER_REQUIRED",
  "ORGANIZATION_OWNER_TRANSFER_REQUIRED",
  "ORGANIZATION_MEMBER_NOT_FOUND",
] as const;

export const registerOrganizationMemberRoutes = (
  routes: Hono,
  dependencies: OrganizationRouteDependencies,
) => {
  registerDirectory(routes, dependencies);
  registerRole(routes, dependencies);
  registerRemoval(routes, dependencies);
  registerTransfer(routes, dependencies);
  registerAudit(routes, dependencies);
};

const registerDirectory = (routes: Hono, dependencies: OrganizationRouteDependencies) => {
  routes.get(
    `${base}/members`,
    organizationRouteDocumentation({
      operationId: "listOrganizationMembers",
      summary: "List the shared organization's members",
      response: OrganizationMembersResponseSchema,
      parameters: [organizationPathParameter],
      query: OrganizationDirectoryQuerySchema,
      errors: organizationReadErrors,
    }),
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const program = Effect.gen(function* () {
        const actor = yield* organizationRouteActor(context, dependencies, "members-read");
        const query = yield* organizationQuery(context, OrganizationDirectoryQuerySchema);
        return yield* dependencies.organizationService.listMembers({ ...query, actor });
      });
      return runRouteEffect(context, correlationId, program, (value) =>
        organizationResponse(context, OrganizationMembersResponseSchema, value, correlationId),
      );
    },
  );
};

const registerRole = (routes: Hono, dependencies: OrganizationRouteDependencies) => {
  routes.patch(
    `${base}/members/:userId`,
    organizationRouteDocumentation({
      operationId: "setOrganizationMemberRole",
      summary: "Change a non-owner role as organization owner",
      request: OrganizationMemberRoleRequestSchema,
      response: OrganizationMemberSchema,
      parameters: memberParameters,
      errors: mutationErrors,
    }),
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const program = Effect.gen(function* () {
        const actor = yield* organizationRouteActor(context, dependencies, "admins-manage");
        const input = yield* decodeRequestJson(
          context.req.raw,
          OrganizationMemberRoleRequestSchema,
        );
        return yield* dependencies.organizationService.setRole({
          ...input,
          actor,
          userId: context.req.param("userId"),
          now: dependencies.now(),
          correlationId,
        });
      });
      return runRouteEffect(context, correlationId, program, (value) =>
        organizationResponse(context, OrganizationMemberSchema, value, correlationId),
      );
    },
  );
};

const registerRemoval = (routes: Hono, dependencies: OrganizationRouteDependencies) => {
  routes.delete(
    `${base}/members/:userId`,
    organizationRouteDocumentation({
      operationId: "removeOrganizationMember",
      summary: "Remove a member and revoke their artifact grants",
      response: OrganizationMemberRemovalSchema,
      parameters: memberParameters,
      errors: mutationErrors,
    }),
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const program = Effect.gen(function* () {
        const actor = yield* organizationRouteActor(context, dependencies, "members-manage");
        return yield* dependencies.organizationService.removeMember({
          actor,
          userId: context.req.param("userId"),
          now: dependencies.now(),
          correlationId,
        });
      });
      return runRouteEffect(context, correlationId, program, (value) =>
        organizationResponse(context, OrganizationMemberRemovalSchema, value, correlationId),
      );
    },
  );
  routes.post(
    `${base}/leave`,
    organizationRouteDocumentation({
      operationId: "leaveOrganization",
      summary: "Leave an organization after transferring any ownership",
      response: OrganizationMemberRemovalSchema,
      parameters: [organizationPathParameter],
      errors: [...organizationReadErrors, "ORGANIZATION_OWNER_TRANSFER_REQUIRED"],
    }),
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const program = Effect.gen(function* () {
        const actor = yield* organizationRouteActor(context, dependencies, "organization-read");
        return yield* dependencies.organizationService.removeMember({
          actor,
          userId: actor.userId,
          leave: true,
          now: dependencies.now(),
          correlationId,
        });
      });
      return runRouteEffect(context, correlationId, program, (value) =>
        organizationResponse(context, OrganizationMemberRemovalSchema, value, correlationId),
      );
    },
  );
};

const registerTransfer = (routes: Hono, dependencies: OrganizationRouteDependencies) => {
  routes.post(
    `${base}/transfer-ownership`,
    organizationRouteDocumentation({
      operationId: "transferOrganizationOwnership",
      summary: "Transfer ownership to an existing member",
      request: OrganizationTransferRequestSchema,
      response: OrganizationMemberSchema,
      parameters: [organizationPathParameter],
      errors: mutationErrors,
    }),
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const program = Effect.gen(function* () {
        const actor = yield* organizationRouteActor(context, dependencies, "ownership-transfer");
        const input = yield* decodeRequestJson(context.req.raw, OrganizationTransferRequestSchema);
        return yield* dependencies.organizationService.transfer({
          ...input,
          actor,
          now: dependencies.now(),
          correlationId,
        });
      });
      return runRouteEffect(context, correlationId, program, (value) =>
        organizationResponse(context, OrganizationMemberSchema, value, correlationId),
      );
    },
  );
};

const registerAudit = (routes: Hono, dependencies: OrganizationRouteDependencies) => {
  routes.get(
    `${base}/audit-events`,
    organizationRouteDocumentation({
      operationId: "listOrganizationAudit",
      summary: "Read organization audit events as owner or admin",
      response: OrganizationAuditPageSchema,
      parameters: [organizationPathParameter],
      query: OrganizationAuditQuerySchema,
      errors: organizationReadErrors,
    }),
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const program = Effect.gen(function* () {
        const actor = yield* organizationRouteActor(context, dependencies, "audit-read");
        const query = yield* organizationQuery(context, OrganizationAuditQuerySchema);
        return yield* dependencies.organizationService.audit({ ...query, actor });
      });
      return runRouteEffect(context, correlationId, program, (value) =>
        organizationResponse(context, OrganizationAuditPageSchema, value, correlationId),
      );
    },
  );
};
