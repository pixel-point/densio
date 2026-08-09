import {
  BillingSessionResponseSchema,
  BillingStatusSchema,
  successEnvelope,
} from "@ffmpeg-api/shared";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";

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
import {
  bearerSecurity,
  headerParameter,
  problemResponse,
  successResponse,
} from "./openapi-support.ts";

const WebhookResponseSchema = Schema.Struct({ processed: Schema.Boolean });
const decodeBillingSessionEnvelope = Schema.decodeUnknownSync(
  successEnvelope(BillingSessionResponseSchema),
);
const decodeBillingStatusEnvelope = Schema.decodeUnknownSync(successEnvelope(BillingStatusSchema));
const decodeWebhookEnvelope = Schema.decodeUnknownSync(successEnvelope(WebhookResponseSchema));
const checkoutDocumentation = describeRoute({
  operationId: "createCheckoutSession",
  responses: {
    "201": successResponse("A Stripe Checkout session was created.", BillingSessionResponseSchema),
    "401": problemResponse("A valid bearer token is required."),
    "502": problemResponse("Stripe could not create the session."),
  },
  security: bearerSecurity,
  summary: "Create a Pro checkout session",
  tags: ["Billing"],
});
const portalDocumentation = describeRoute({
  operationId: "createBillingPortalSession",
  responses: {
    "201": successResponse(
      "A Stripe Billing Portal session was created.",
      BillingSessionResponseSchema,
    ),
    "401": problemResponse("A valid bearer token is required."),
    "409": problemResponse("The user has no Stripe customer to manage."),
    "502": problemResponse("Stripe could not create the session."),
  },
  security: bearerSecurity,
  summary: "Create a billing portal session",
  tags: ["Billing"],
});
const billingStatusDocumentation = describeRoute({
  operationId: "getBillingStatus",
  responses: {
    "200": successResponse("The user's current billing entitlement.", BillingStatusSchema),
    "401": problemResponse("A valid bearer token is required."),
  },
  security: bearerSecurity,
  summary: "Get billing status",
  tags: ["Billing"],
});
const webhookDocumentation = describeRoute({
  operationId: "handleStripeWebhook",
  parameters: [
    headerParameter("stripe-signature", "Stripe signature for the exact request bytes.", true),
  ],
  requestBody: {
    content: { "application/json": { schema: {} } },
    description: "Raw Stripe event JSON. The exact bytes are signature-verified before parsing.",
    required: true,
  },
  responses: {
    "200": successResponse("The Stripe event was accepted.", WebhookResponseSchema),
    "400": problemResponse("The signature or event payload is invalid."),
  },
  summary: "Receive a Stripe webhook",
  tags: ["Billing"],
});

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
  routes.post("/v1/billing/checkout", checkoutDocumentation, async (context) => {
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
  routes.post("/v1/billing/portal", portalDocumentation, async (context) => {
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
  routes.get("/v1/billing/status", billingStatusDocumentation, async (context) => {
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
  routes.post("/v1/billing/webhook", webhookDocumentation, async (context) => {
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
