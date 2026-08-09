import { CapabilitiesSchema, type Capabilities, type Plan, successEnvelope } from "@densio/shared";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";

import type { AuthService } from "../auth/auth-service.ts";
import type { BillingService } from "../billing/billing-service.ts";
import type { BillingPriceIds } from "../billing/billing-repository.ts";
import { internalErrorProblemDescriptor } from "../errors/problem-details.ts";
import {
  beginRequest,
  optionalBearerToken,
  runRouteEffect,
  successEnvelopeInput,
} from "./route-support.ts";
import { optionalBearerSecurity, problemResponses, successResponse } from "./openapi-support.ts";
import { authRequiredProblemDescriptor } from "./problems/auth-problems.ts";
import { billingUserProblemDescriptor } from "./problems/billing-problems.ts";

const decodeCapabilitiesEnvelope = Schema.decodeUnknownSync(successEnvelope(CapabilitiesSchema));
const capabilitiesDocumentation = describeRoute({
  description:
    "Returns free-plan capabilities anonymously and plan-specific capabilities for a valid bearer token.",
  operationId: "getCapabilities",
  responses: {
    "200": successResponse("The effective API capabilities.", CapabilitiesSchema),
    ...problemResponses(
      authRequiredProblemDescriptor,
      billingUserProblemDescriptor,
      internalErrorProblemDescriptor,
    ),
  },
  security: optionalBearerSecurity,
  summary: "Get API capabilities",
  tags: ["Capabilities"],
});

export interface CapabilityRouteDependencies {
  readonly authService: AuthService["Service"];
  readonly billingService: BillingService["Service"];
  readonly capabilitiesForPlan: (plan: Plan) => Capabilities;
  readonly createCorrelationId: () => string;
  readonly now: () => number;
  readonly priceIds: BillingPriceIds;
}

export const createCapabilitiesRoutes = (dependencies: CapabilityRouteDependencies) => {
  const routes = new Hono();
  routes.get("/v1/capabilities", capabilitiesDocumentation, async (context) => {
    const correlationId = beginRequest(context, dependencies.createCorrelationId);
    const program = Effect.gen(function* () {
      const token = yield* optionalBearerToken(context.req.header("authorization"));
      if (token === null) return dependencies.capabilitiesForPlan("free");
      const identity = yield* dependencies.authService.lookupAccess({
        accessToken: token,
        now: dependencies.now(),
      });
      const billing = yield* dependencies.billingService.getEntitlement({
        now: dependencies.now(),
        priceIds: dependencies.priceIds,
        userId: identity.userId,
      });
      return dependencies.capabilitiesForPlan(billing.entitlements.plan);
    });
    return runRouteEffect(context, correlationId, program, (capabilities) =>
      context.json(decodeCapabilitiesEnvelope(successEnvelopeInput(capabilities, correlationId))),
    );
  });
  return routes;
};
