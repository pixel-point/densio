import {
  BillingSessionResponseSchema,
  BillingStatusSchema,
  successEnvelope,
} from "@ffmpeg-api/shared";
import { Effect, Schema } from "effect";
import { Hono } from "hono";

import type { AuthService } from "../auth/auth-service.ts";
import type { EffectiveBillingEntitlement } from "../billing/billing-repository.ts";
import type { BillingConfig, BillingService } from "../billing/billing-service.ts";
import {
  authenticateRequest,
  beginRequest,
  readRawBody,
  requireHeader,
  runRouteEffect,
  successEnvelopeInput,
} from "./route-support.ts";

const WebhookResponseSchema = Schema.Struct({ processed: Schema.Boolean });
const decodeBillingSessionEnvelope = Schema.decodeUnknownSync(
  successEnvelope(BillingSessionResponseSchema),
);
const decodeBillingStatusEnvelope = Schema.decodeUnknownSync(successEnvelope(BillingStatusSchema));
const decodeWebhookEnvelope = Schema.decodeUnknownSync(successEnvelope(WebhookResponseSchema));

export interface BillingRouteDependencies {
  readonly authService: AuthService["Service"];
  readonly billingConfig: BillingConfig;
  readonly billingService: BillingService["Service"];
  readonly billingSessionTtlMs: number;
  readonly createCorrelationId: () => string;
  readonly now: () => number;
}

export const createBillingRoutes = (dependencies: BillingRouteDependencies) => {
  const routes = new Hono();
  registerCheckoutRoute(routes, dependencies);
  registerPortalRoute(routes, dependencies);
  registerBillingStatusRoute(routes, dependencies);
  registerWebhookRoute(routes, dependencies);
  return routes;
};

const registerCheckoutRoute = (routes: Hono, dependencies: BillingRouteDependencies) => {
  routes.post("/v1/billing/checkout", async (context) => {
    const correlationId = beginRequest(context, dependencies.createCorrelationId);
    const now = dependencies.now();
    const program = Effect.gen(function* () {
      const identity = yield* authenticateRequest(context.req.raw, dependencies.authService, now);
      return yield* dependencies.billingService.createCheckout({
        config: dependencies.billingConfig,
        userId: identity.userId,
      });
    });
    return runRouteEffect(context, correlationId, program, (session) =>
      context.json(
        decodeBillingSessionEnvelope(
          successEnvelopeInput(
            {
              expiresAt: toIso(now + dependencies.billingSessionTtlMs),
              kind: "checkout",
              url: session.url,
            },
            correlationId,
          ),
        ),
        201,
      ),
    );
  });
};

const registerPortalRoute = (routes: Hono, dependencies: BillingRouteDependencies) => {
  routes.post("/v1/billing/portal", async (context) => {
    const correlationId = beginRequest(context, dependencies.createCorrelationId);
    const now = dependencies.now();
    const program = Effect.gen(function* () {
      const identity = yield* authenticateRequest(context.req.raw, dependencies.authService, now);
      return yield* dependencies.billingService.createPortal({
        config: dependencies.billingConfig,
        userId: identity.userId,
      });
    });
    return runRouteEffect(context, correlationId, program, (session) =>
      context.json(
        decodeBillingSessionEnvelope(
          successEnvelopeInput(
            {
              expiresAt: toIso(now + dependencies.billingSessionTtlMs),
              kind: "portal",
              url: session.url,
            },
            correlationId,
          ),
        ),
        201,
      ),
    );
  });
};

const registerBillingStatusRoute = (routes: Hono, dependencies: BillingRouteDependencies) => {
  routes.get("/v1/billing/status", async (context) => {
    const correlationId = beginRequest(context, dependencies.createCorrelationId);
    const program = Effect.gen(function* () {
      const identity = yield* authenticateRequest(
        context.req.raw,
        dependencies.authService,
        dependencies.now(),
      );
      return yield* dependencies.billingService.getEntitlement({
        proPriceId: dependencies.billingConfig.proPriceId,
        userId: identity.userId,
      });
    });
    return runRouteEffect(context, correlationId, program, (entitlement) =>
      context.json(
        decodeBillingStatusEnvelope(
          successEnvelopeInput(toBillingStatus(entitlement), correlationId),
        ),
      ),
    );
  });
};

const registerWebhookRoute = (routes: Hono, dependencies: BillingRouteDependencies) => {
  routes.post("/v1/billing/webhook", async (context) => {
    const correlationId = beginRequest(context, dependencies.createCorrelationId);
    const program = Effect.gen(function* () {
      const signature = yield* requireHeader(context.req.header("stripe-signature"));
      const rawBody = yield* readRawBody(context.req.raw);
      return yield* dependencies.billingService.handleWebhook({
        config: dependencies.billingConfig,
        now: dependencies.now(),
        rawBody,
        signature,
      });
    });
    return runRouteEffect(context, correlationId, program, (result) =>
      context.json(decodeWebhookEnvelope(successEnvelopeInput(result, correlationId))),
    );
  });
};

const toBillingStatus = (entitlement: EffectiveBillingEntitlement) => ({
  entitlementSource: entitlement.source,
  plan: entitlement.entitlements.plan,
  ...(entitlement.renewsAt === null ? {} : { renewsAt: toIso(entitlement.renewsAt) }),
  ...(entitlement.subscriptionStatus === null
    ? {}
    : {
        subscriptionStatus: entitlement.subscriptionStatus,
      }),
});

const toIso = (timestamp: number) => new Date(timestamp).toISOString();
