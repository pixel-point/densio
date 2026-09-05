import {
  BillingContactRequestSchema,
  BillingContactResponseSchema,
  BillingSessionResponseSchema,
  BillingStatusSchema,
  CheckoutPlanRequestSchema,
  JobIdempotencyKeySchema,
  successEnvelope,
} from "@densio/shared";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import type { AuthService } from "../auth/auth-service.ts";
import type { EffectiveBillingEntitlement } from "../billing/billing-repository.ts";
import type { BillingConfig, BillingService } from "../billing/billing-service.ts";
import type { OrganizationService } from "../organizations/organization-service.ts";
import {
  internalErrorProblemDescriptor,
  invalidRequestProblemDescriptor,
  requestTooLargeProblemDescriptor,
} from "../errors/problem-details.ts";
import {
  beginRequest,
  decodeRequestJson,
  invalidRequestProblem,
  readRawBody,
  requireHeader,
  runRouteEffect,
  successEnvelopeInput,
} from "./route-support.ts";
import {
  bearerSecurity,
  headerParameter,
  jsonRequest,
  problemResponses,
  successResponse,
} from "./openapi-support.ts";
import {
  organizationPathParameter,
  organizationRouteActor,
  organizationReadErrors,
} from "./organization-route-support.ts";
import { authRequiredProblemDescriptor } from "./problems/auth-problems.ts";
import {
  billingCustomerProblemDescriptor,
  invalidStripeWebhookProblemDescriptor,
  stripeUnavailableProblemDescriptor,
  unmatchedWebhookProblemDescriptor,
} from "./problems/billing-problems.ts";
import { organizationProblemDescriptor } from "./problems/organization-problems.ts";

const WebhookResponseSchema = Schema.Struct({ processed: Schema.Boolean });
const decodeSessionEnvelope = Schema.decodeUnknownSync(
  successEnvelope(BillingSessionResponseSchema),
);
const decodeStatusEnvelope = Schema.decodeUnknownSync(successEnvelope(BillingStatusSchema));
const decodeContactEnvelope = Schema.decodeUnknownSync(
  successEnvelope(BillingContactResponseSchema),
);
const decodeWebhookEnvelope = Schema.decodeUnknownSync(successEnvelope(WebhookResponseSchema));
const ownerErrors = [
  ...organizationReadErrors,
  "ORGANIZATION_OWNER_REQUIRED",
  "ORGANIZATION_BILLING_BUSY",
  "IDEMPOTENCY_CONFLICT",
] as const;
const organizationProblems = (
  codes: readonly Parameters<typeof organizationProblemDescriptor>[0][],
) => codes.map(organizationProblemDescriptor);
const checkoutDocumentation = describeRoute({
  operationId: "createOrganizationCheckoutSession",
  summary: "Create or resume an organization paid-plan checkout",
  tags: ["Billing"],
  security: bearerSecurity,
  parameters: [
    organizationPathParameter,
    headerParameter(
      "idempotency-key",
      "Required organization-scoped checkout identity.",
      true,
      JobIdempotencyKeySchema,
    ),
  ],
  requestBody: jsonRequest(CheckoutPlanRequestSchema),
  responses: {
    "201": successResponse(
      "An organization Stripe Checkout session was created or resumed.",
      BillingSessionResponseSchema,
    ),
    ...problemResponses(
      authRequiredProblemDescriptor,
      invalidRequestProblemDescriptor,
      requestTooLargeProblemDescriptor,
      internalErrorProblemDescriptor,
      stripeUnavailableProblemDescriptor,
      unmatchedWebhookProblemDescriptor,
      ...organizationProblems(ownerErrors),
    ),
  },
});
const portalDocumentation = describeRoute({
  operationId: "createOrganizationBillingPortalSession",
  summary: "Create an organization billing portal session",
  tags: ["Billing"],
  security: bearerSecurity,
  parameters: [organizationPathParameter],
  responses: {
    "201": successResponse(
      "A provider-defined short-lived billing portal link was created.",
      BillingSessionResponseSchema,
    ),
    ...problemResponses(
      authRequiredProblemDescriptor,
      billingCustomerProblemDescriptor,
      internalErrorProblemDescriptor,
      stripeUnavailableProblemDescriptor,
      ...organizationProblems(ownerErrors),
    ),
  },
});
const statusDocumentation = describeRoute({
  operationId: "getOrganizationBillingStatus",
  summary: "Get organization billing status",
  tags: ["Billing"],
  security: bearerSecurity,
  parameters: [organizationPathParameter],
  responses: {
    "200": successResponse("The organization's global billing entitlement.", BillingStatusSchema),
    ...problemResponses(
      authRequiredProblemDescriptor,
      internalErrorProblemDescriptor,
      ...organizationProblems(organizationReadErrors),
    ),
  },
});
const contactDocumentation = describeRoute({
  operationId: "updateOrganizationBillingContact",
  summary: "Update organization billing contact",
  tags: ["Billing"],
  security: bearerSecurity,
  parameters: [organizationPathParameter],
  requestBody: jsonRequest(BillingContactRequestSchema),
  responses: {
    "200": successResponse(
      "The organization billing contact was updated.",
      BillingContactResponseSchema,
    ),
    ...problemResponses(
      authRequiredProblemDescriptor,
      invalidRequestProblemDescriptor,
      requestTooLargeProblemDescriptor,
      internalErrorProblemDescriptor,
      stripeUnavailableProblemDescriptor,
      ...organizationProblems(ownerErrors),
    ),
  },
});
const webhookDocumentation = describeRoute({
  operationId: "handleStripeWebhook",
  summary: "Receive a Stripe webhook",
  tags: ["Billing"],
  parameters: [
    headerParameter("stripe-signature", "Stripe signature for the exact request bytes.", true),
  ],
  requestBody: {
    content: { "application/json": { schema: {} } },
    description: "Raw Stripe event JSON. Signature verification uses the exact bytes.",
    required: true,
  },
  responses: {
    "200": successResponse("The Stripe event was accepted.", WebhookResponseSchema),
    ...problemResponses(
      invalidStripeWebhookProblemDescriptor,
      internalErrorProblemDescriptor,
      stripeUnavailableProblemDescriptor,
      unmatchedWebhookProblemDescriptor,
    ),
  },
});

export interface BillingRouteDependencies {
  readonly authService: AuthService["Service"];
  readonly organizationService: OrganizationService;
  readonly billingConfig: BillingConfig;
  readonly billingService: BillingService["Service"];
  readonly createCorrelationId: () => string;
  readonly now: () => number;
}

export const createBillingRoutes = (dependencies: BillingRouteDependencies) => {
  const routes = new Hono();
  registerCheckout(routes, dependencies);
  registerPortal(routes, dependencies);
  registerStatus(routes, dependencies);
  registerContact(routes, dependencies);
  registerWebhook(routes, dependencies);
  return routes;
};

const registerCheckout = (routes: Hono, dependencies: BillingRouteDependencies) =>
  routes.post(
    "/v1/organizations/:organizationId/billing/checkout",
    checkoutDocumentation,
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const program = Effect.gen(function* () {
        const input = yield* decodeRequestJson(context.req.raw, CheckoutPlanRequestSchema);
        const idempotencyKey = yield* requireHeader(context.req.header("idempotency-key")).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(JobIdempotencyKeySchema)),
          Effect.mapError(() => invalidRequestProblem()),
        );
        const actor = yield* organizationRouteActor(context, dependencies, "billing-write");
        return yield* dependencies.billingService.createCheckout({
          actor,
          config: dependencies.billingConfig,
          plan: input.plan,
          idempotencyKey,
          correlationId,
        });
      });
      return runRouteEffect(context, correlationId, program, (session) =>
        context.json(decodeSessionEnvelope(successEnvelopeInput(session, correlationId)), 201),
      );
    },
  );
const registerPortal = (routes: Hono, dependencies: BillingRouteDependencies) =>
  routes.post(
    "/v1/organizations/:organizationId/billing/portal",
    portalDocumentation,
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const program = Effect.gen(function* () {
        const actor = yield* organizationRouteActor(context, dependencies, "billing-write");
        return yield* dependencies.billingService.createPortal({
          actor,
          config: dependencies.billingConfig,
          correlationId,
        });
      });
      return runRouteEffect(context, correlationId, program, (session) =>
        context.json(decodeSessionEnvelope(successEnvelopeInput(session, correlationId)), 201),
      );
    },
  );
const registerStatus = (routes: Hono, dependencies: BillingRouteDependencies) =>
  routes.get(
    "/v1/organizations/:organizationId/billing/status",
    statusDocumentation,
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const program = Effect.gen(function* () {
        const actor = yield* organizationRouteActor(context, dependencies, "billing-read");
        return yield* dependencies.billingService.getEntitlement({
          now: dependencies.now(),
          priceIds: dependencies.billingConfig.priceIds,
          organizationId: actor.organizationId,
        });
      });
      return runRouteEffect(context, correlationId, program, (entitlement) =>
        context.json(
          decodeStatusEnvelope(successEnvelopeInput(toBillingStatus(entitlement), correlationId)),
        ),
      );
    },
  );
const registerContact = (routes: Hono, dependencies: BillingRouteDependencies) =>
  routes.patch(
    "/v1/organizations/:organizationId/billing/contact",
    contactDocumentation,
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const program = Effect.gen(function* () {
        const input = yield* decodeRequestJson(context.req.raw, BillingContactRequestSchema);
        const actor = yield* organizationRouteActor(context, dependencies, "billing-write");
        return yield* dependencies.billingService.updateContact({
          actor,
          billingEmail: input.billingEmail,
          correlationId,
        });
      });
      return runRouteEffect(context, correlationId, program, (result) =>
        context.json(decodeContactEnvelope(successEnvelopeInput(result, correlationId))),
      );
    },
  );
const registerWebhook = (routes: Hono, dependencies: BillingRouteDependencies) =>
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
const toBillingStatus = (entitlement: EffectiveBillingEntitlement) => ({
  organizationId: entitlement.organizationId,
  billingEmail: entitlement.billingEmail,
  credits: {
    ...entitlement.credits,
    resetsAt: new Date(entitlement.credits.resetsAt).toISOString(),
  },
  entitlementSource: entitlement.source,
  plan: entitlement.entitlements.plan,
  ...(entitlement.renewsAt === null
    ? {}
    : { renewsAt: new Date(entitlement.renewsAt).toISOString() }),
  ...(entitlement.subscriptionStatus === null
    ? {}
    : { subscriptionStatus: entitlement.subscriptionStatus }),
});
