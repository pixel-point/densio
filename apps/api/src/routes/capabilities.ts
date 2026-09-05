import {
  CapabilitiesSchema,
  PublicCapabilitiesSchema,
  type PublicCapabilities,
  type Plan,
  successEnvelope,
} from "@densio/shared";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import type { AuthService } from "../auth/auth-service.ts";
import type { BillingService } from "../billing/billing-service.ts";
import type { BillingPriceIds } from "../billing/billing-repository.ts";
import type { OrganizationService } from "../organizations/organization-service.ts";
import { organizationOperations } from "../organizations/organization-access.ts";
import type { buildCapabilities } from "../capabilities.ts";
import { internalErrorProblemDescriptor } from "../errors/problem-details.ts";
import { beginRequest, runRouteEffect, successEnvelopeInput } from "./route-support.ts";
import { bearerSecurity, problemResponses, successResponse } from "./openapi-support.ts";
import { authRequiredProblemDescriptor } from "./problems/auth-problems.ts";
import {
  organizationRouteActor,
  organizationPathParameter,
  organizationReadErrors,
} from "./organization-route-support.ts";
import { organizationProblemDescriptor } from "./problems/organization-problems.ts";

const decodeOrganizationEnvelope = Schema.decodeUnknownSync(successEnvelope(CapabilitiesSchema));
const decodePublicEnvelope = Schema.decodeUnknownSync(successEnvelope(PublicCapabilitiesSchema));
const publicDocumentation = describeRoute({
  operationId: "getPublicCapabilities",
  summary: "Get public API capabilities and organization plan catalog",
  tags: ["Capabilities"],
  description:
    "Anonymous common media capabilities and pricing catalog. No effective plan, organization, or permissions are inferred.",
  responses: {
    "200": successResponse(
      "Public capabilities and per-organization plans.",
      PublicCapabilitiesSchema,
    ),
    ...problemResponses(internalErrorProblemDescriptor),
  },
});
const organizationDocumentation = describeRoute({
  operationId: "getOrganizationCapabilities",
  summary: "Get effective organization capabilities",
  tags: ["Capabilities"],
  security: bearerSecurity,
  parameters: [organizationPathParameter],
  responses: {
    "200": successResponse(
      "The selected organization's effective plan and caller permissions.",
      CapabilitiesSchema,
    ),
    ...problemResponses(
      authRequiredProblemDescriptor,
      internalErrorProblemDescriptor,
      ...organizationReadErrors.map(organizationProblemDescriptor),
    ),
  },
});
export interface CapabilityRouteDependencies {
  readonly authService: AuthService["Service"];
  readonly organizationService: OrganizationService;
  readonly billingService: BillingService["Service"];
  readonly capabilitiesForPlan: (plan: Plan) => ReturnType<typeof buildCapabilities>;
  readonly publicCapabilities: PublicCapabilities;
  readonly createCorrelationId: () => string;
  readonly now: () => number;
  readonly priceIds: BillingPriceIds;
}

export const createCapabilitiesRoutes = (dependencies: CapabilityRouteDependencies) => {
  const routes = new Hono();
  routes.get("/v1/capabilities", publicDocumentation, (context) => {
    const correlationId = beginRequest(context, dependencies.createCorrelationId);
    return context.json(
      decodePublicEnvelope(successEnvelopeInput(dependencies.publicCapabilities, correlationId)),
    );
  });
  routes.get(
    "/v1/organizations/:organizationId/capabilities",
    organizationDocumentation,
    async (context) => {
      context.header("cache-control", "no-store");
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const program = Effect.gen(function* () {
        const actor = yield* organizationRouteActor(context, dependencies, "organization-read");
        const billing = yield* dependencies.billingService.getEntitlement({
          now: dependencies.now(),
          priceIds: dependencies.priceIds,
          organizationId: actor.organizationId,
        });
        return {
          ...dependencies.capabilitiesForPlan(billing.entitlements.plan),
          scope: "organization",
          organizationId: actor.organizationId,
          organizationName: actor.organization.name,
          role: actor.membership.role,
          actions: organizationOperations(actor.membership.role),
        };
      });
      return runRouteEffect(context, correlationId, program, (capabilities) =>
        context.json(decodeOrganizationEnvelope(successEnvelopeInput(capabilities, correlationId))),
      );
    },
  );
  return routes;
};
