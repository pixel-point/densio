import {
  CapabilitiesSchema,
  type Capabilities,
  type Plan,
  successEnvelope,
} from "@ffmpeg-api/shared";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";

import type { AuthService } from "../auth/auth-service.ts";
import type { BillingService } from "../billing/billing-service.ts";
import {
  beginRequest,
  optionalBearerToken,
  runRouteEffect,
  successEnvelopeInput,
} from "./route-support.ts";
import { optionalBearerSecurity, problemResponse, successResponse } from "./openapi-support.ts";

const decodeCapabilitiesEnvelope = Schema.decodeUnknownSync(successEnvelope(CapabilitiesSchema));
const capabilitiesDocumentation = describeRoute({
  description:
    "Returns free-plan capabilities anonymously and plan-specific capabilities for a valid bearer token.",
  operationId: "getCapabilities",
  responses: {
    "200": successResponse("The effective API capabilities.", CapabilitiesSchema),
    "401": problemResponse("The supplied bearer token is invalid."),
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
  readonly proPriceId: string;
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
        proPriceId: dependencies.proPriceId,
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
