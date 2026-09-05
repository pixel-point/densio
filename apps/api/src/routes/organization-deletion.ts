import { OrganizationDeletionReceiptSchema } from "@densio/shared";
import { Effect } from "effect";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import type { OrganizationDeletionService } from "../organizations/organization-deletion-service.ts";
import {
  organizationResponse,
  organizationPathParameter,
  type OrganizationRouteDependencies,
} from "./organization-route-support.ts";
import { authenticateRequest, beginRequest, runRouteEffect } from "./route-support.ts";
import { bearerSecurity, problemResponses, successResponse } from "./openapi-support.ts";
import { authRequiredProblemDescriptor } from "./problems/auth-problems.ts";
import { internalErrorProblemDescriptor } from "../errors/problem-details.ts";
import {
  stripeUnavailableProblemDescriptor,
  unmatchedWebhookProblemDescriptor,
} from "./problems/billing-problems.ts";
import { organizationProblemDescriptor } from "./problems/organization-problems.ts";

export interface OrganizationDeletionRouteDependencies extends Pick<
  OrganizationRouteDependencies,
  "authService" | "organizationService" | "now" | "createCorrelationId"
> {
  readonly deletionService: OrganizationDeletionService;
}

export const createOrganizationDeletionRoutes = (
  dependencies: OrganizationDeletionRouteDependencies,
) => {
  const routes = new Hono();
  routes.delete(
    "/v1/organizations/:organizationId",
    describeRoute({
      operationId: "deleteOrganization",
      summary: "Close an organization and queue durable byte cleanup",
      tags: ["Organizations"],
      security: bearerSecurity,
      parameters: [organizationPathParameter],
      description:
        "Owner-only. Active jobs, uploads, subscriptions, and unresolved checkouts block closure with structured blockers. This does not cancel billing. Acceptance revokes access and replaces member defaults atomically. Poll the returned statusUrl; failed cleanup remains retryable in deleting state.",
      responses: {
        "202": successResponse(
          "Deletion is accepted or remains in progress.",
          OrganizationDeletionReceiptSchema,
        ),
        "200": successResponse("Deletion is complete.", OrganizationDeletionReceiptSchema),
        ...problemResponses(
          authRequiredProblemDescriptor,
          internalErrorProblemDescriptor,
          stripeUnavailableProblemDescriptor,
          unmatchedWebhookProblemDescriptor,
          ...(
            [
              "ORGANIZATION_NOT_FOUND",
              "ORGANIZATION_OWNER_REQUIRED",
              "ORGANIZATION_DELETION_BLOCKED",
              "ORGANIZATION_BILLING_BUSY",
            ] as const
          ).map(organizationProblemDescriptor),
        ),
      },
    }),
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const program = Effect.gen(function* () {
        const identity = yield* authenticateRequest(
          context.req.raw,
          dependencies.authService,
          dependencies.now(),
        );
        const actor = yield* dependencies.organizationService.authorize(
          { organizationId: context.req.param("organizationId"), userId: identity.userId },
          "organization-delete",
          true,
        );
        return yield* dependencies.deletionService.request({ actor, correlationId });
      });
      return runRouteEffect(context, correlationId, program, (receipt) =>
        organizationResponse(
          context,
          OrganizationDeletionReceiptSchema,
          receipt,
          correlationId,
          receipt.state === "deleted" ? 200 : 202,
        ),
      );
    },
  );
  return routes;
};
