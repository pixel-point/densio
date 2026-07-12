import {
  CapabilitiesSchema,
  type Capabilities,
  type Plan,
  successEnvelope,
} from "@ffmpeg-api/shared";
import { Effect, Schema } from "effect";
import { Hono } from "hono";

import type { AuthService } from "../auth/auth-service.ts";
import type { BillingService } from "../billing/billing-service.ts";
import {
  beginRequest,
  optionalBearerToken,
  runRouteEffect,
  successEnvelopeInput,
} from "./route-support.ts";

const decodeCapabilitiesEnvelope = Schema.decodeUnknownSync(successEnvelope(CapabilitiesSchema));

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
  routes.get("/v1/capabilities", async (context) => {
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
