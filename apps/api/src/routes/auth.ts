import {
  AuthPollResponseSchema,
  AuthStartResponseSchema,
  AuthStatusSchema,
  AuthTokensSchema,
  EmailAddressSchema,
  LogoutResponseSchema,
  successEnvelope,
} from "@densio/shared";
import { Effect, Schema } from "effect";
import { Hono, type Context as HonoContext } from "hono";
import { describeRoute } from "hono-openapi";

import type { AuthConfig, AuthService } from "../auth/auth-service.ts";
import type { BillingService } from "../billing/billing-service.ts";
import type { BillingPriceIds } from "../billing/billing-repository.ts";
import {
  internalErrorProblemDescriptor,
  invalidRequestProblemDescriptor,
  requestTooLargeProblemDescriptor,
} from "../errors/problem-details.ts";
import {
  beginRequest,
  decodeRequestJson,
  optionalBearerToken,
  requireBearerToken,
  runRouteEffect,
  successEnvelopeInput,
} from "./route-support.ts";
import {
  bearerSecurity,
  jsonRequest,
  optionalBearerSecurity,
  problemResponses,
  queryParameter,
  successResponse,
} from "./openapi-support.ts";
import {
  authChallengeExpiredProblemDescriptor,
  authChallengeInvalidProblemDescriptor,
  authChallengeUsedProblemDescriptor,
  authRateLimitProblemDescriptor,
  authRequiredProblemDescriptor,
  invalidEmailProblemDescriptor,
  refreshReplayProblemDescriptor,
} from "./problems/auth-problems.ts";

const LoginRequestSchema = Schema.Struct({ email: EmailAddressSchema });
const PollRequestSchema = Schema.Struct({ pollToken: Schema.NonEmptyString });
const RefreshRequestSchema = Schema.Struct({ refreshToken: Schema.NonEmptyString });
const decodeAuthStartEnvelope = Schema.decodeUnknownSync(successEnvelope(AuthStartResponseSchema));
const decodeAuthPollEnvelope = Schema.decodeUnknownSync(successEnvelope(AuthPollResponseSchema));
const decodeAuthTokensEnvelope = Schema.decodeUnknownSync(successEnvelope(AuthTokensSchema));
const decodeLogoutEnvelope = Schema.decodeUnknownSync(successEnvelope(LogoutResponseSchema));
const decodeAuthStatusEnvelope = Schema.decodeUnknownSync(successEnvelope(AuthStatusSchema));
const loginDocumentation = describeRoute({
  operationId: "requestLogin",
  requestBody: jsonRequest(LoginRequestSchema),
  responses: {
    "202": successResponse("A login challenge was created.", AuthStartResponseSchema),
    ...problemResponses(
      invalidRequestProblemDescriptor,
      invalidEmailProblemDescriptor,
      requestTooLargeProblemDescriptor,
      authRateLimitProblemDescriptor,
      internalErrorProblemDescriptor,
    ),
  },
  summary: "Request a magic login link",
  tags: ["Authentication"],
});
const confirmationDocumentation = describeRoute({
  operationId: "confirmLogin",
  parameters: [queryParameter("token", "Magic-link confirmation token.", true)],
  responses: {
    "200": {
      content: { "text/html": { schema: { type: "string" } } },
      description: "The login was confirmed in a browser page.",
    },
    ...problemResponses(
      invalidRequestProblemDescriptor,
      authChallengeInvalidProblemDescriptor,
      authChallengeUsedProblemDescriptor,
      authChallengeExpiredProblemDescriptor,
      internalErrorProblemDescriptor,
    ),
  },
  summary: "Confirm a magic login link",
  tags: ["Authentication"],
});
const pollDocumentation = describeRoute({
  operationId: "pollLogin",
  requestBody: jsonRequest(PollRequestSchema),
  responses: {
    "200": successResponse("The challenge is pending or confirmed.", AuthPollResponseSchema),
    ...problemResponses(
      invalidRequestProblemDescriptor,
      authChallengeInvalidProblemDescriptor,
      authChallengeUsedProblemDescriptor,
      authChallengeExpiredProblemDescriptor,
      requestTooLargeProblemDescriptor,
      internalErrorProblemDescriptor,
    ),
  },
  summary: "Poll a login challenge",
  tags: ["Authentication"],
});
const refreshDocumentation = describeRoute({
  operationId: "refreshSession",
  requestBody: jsonRequest(RefreshRequestSchema),
  responses: {
    "200": successResponse("The session tokens were rotated.", AuthTokensSchema),
    ...problemResponses(
      invalidRequestProblemDescriptor,
      authRequiredProblemDescriptor,
      refreshReplayProblemDescriptor,
      requestTooLargeProblemDescriptor,
      internalErrorProblemDescriptor,
    ),
  },
  summary: "Refresh an authenticated session",
  tags: ["Authentication"],
});
const logoutDocumentation = describeRoute({
  operationId: "logout",
  responses: {
    "200": successResponse("The session was revoked.", LogoutResponseSchema),
    ...problemResponses(authRequiredProblemDescriptor, internalErrorProblemDescriptor),
  },
  security: bearerSecurity,
  summary: "Log out the current session",
  tags: ["Authentication"],
});
const authStatusDocumentation = describeRoute({
  operationId: "getAuthStatus",
  responses: {
    "200": successResponse("The current authentication status.", AuthStatusSchema),
    ...problemResponses(authRequiredProblemDescriptor, internalErrorProblemDescriptor),
  },
  security: optionalBearerSecurity,
  summary: "Get authentication status",
  tags: ["Authentication"],
});

export interface AuthRouteDependencies {
  readonly authConfig: AuthConfig;
  readonly authService: AuthService["Service"];
  readonly billingService: BillingService["Service"];
  readonly createCorrelationId: () => string;
  readonly now: () => number;
  readonly pollAfterSeconds: number;
  readonly priceIds: BillingPriceIds;
  readonly requestIpHash: (request: Request, context: HonoContext) => string;
}

export const createAuthRoutes = (dependencies: AuthRouteDependencies) => {
  const routes = new Hono();
  registerLoginRoute(routes, dependencies);
  registerConfirmationRoute(routes, dependencies);
  registerPollRoute(routes, dependencies);
  registerRefreshRoute(routes, dependencies);
  registerLogoutRoute(routes, dependencies);
  registerStatusRoute(routes, dependencies);
  return routes;
};

const registerLoginRoute = (routes: Hono, dependencies: AuthRouteDependencies) => {
  routes.post("/v1/auth/login", loginDocumentation, async (context) => {
    const correlationId = beginRequest(context, dependencies.createCorrelationId);
    const program = Effect.gen(function* () {
      const input = yield* decodeRequestJson(context.req.raw, LoginRequestSchema);
      return yield* dependencies.authService.requestLogin({
        config: dependencies.authConfig,
        email: input.email,
        now: dependencies.now(),
        requestIpHash: dependencies.requestIpHash(context.req.raw, context),
      });
    });

    return runRouteEffect(context, correlationId, program, (login) =>
      context.json(
        decodeAuthStartEnvelope(
          successEnvelopeInput(
            {
              challengeId: login.challengeId,
              expiresAt: toIso(login.expiresAt),
              pollAfterSeconds: dependencies.pollAfterSeconds,
              pollToken: login.pollingToken,
            },
            correlationId,
          ),
        ),
        202,
      ),
    );
  });
};

const registerConfirmationRoute = (routes: Hono, dependencies: AuthRouteDependencies) => {
  routes.get("/v1/auth/confirm", confirmationDocumentation, async (context) => {
    const correlationId = beginRequest(context, dependencies.createCorrelationId);
    const program = dependencies.authService.confirm({
      confirmationToken: context.req.query("token"),
      now: dependencies.now(),
    });
    return runRouteEffect(context, correlationId, program, () =>
      context.html(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Login confirmed</title></head>
  <body><main><h1>Login confirmed</h1><p>You can return to the Densio CLI.</p></main></body>
</html>`),
    );
  });
};

const registerPollRoute = (routes: Hono, dependencies: AuthRouteDependencies) => {
  routes.post("/v1/auth/poll", pollDocumentation, async (context) => {
    const correlationId = beginRequest(context, dependencies.createCorrelationId);
    const program = Effect.gen(function* () {
      const input = yield* decodeRequestJson(context.req.raw, PollRequestSchema);
      const result = yield* dependencies.authService.poll({
        config: dependencies.authConfig,
        now: dependencies.now(),
        pollingToken: input.pollToken,
      });
      if (result.status === "pending") {
        return {
          expiresAt: toIso(result.expiresAt),
          pollAfterSeconds: dependencies.pollAfterSeconds,
          status: "pending" as const,
        };
      }
      return {
        accessToken: result.accessToken,
        accessTokenExpiresAt: toIso(result.accessExpiresAt),
        refreshToken: result.refreshToken,
        status: "confirmed" as const,
      };
    });
    return runRouteEffect(context, correlationId, program, (result) =>
      context.json(decodeAuthPollEnvelope(successEnvelopeInput(result, correlationId))),
    );
  });
};

const registerRefreshRoute = (routes: Hono, dependencies: AuthRouteDependencies) => {
  routes.post("/v1/auth/refresh", refreshDocumentation, async (context) => {
    const correlationId = beginRequest(context, dependencies.createCorrelationId);
    const program = Effect.gen(function* () {
      const input = yield* decodeRequestJson(context.req.raw, RefreshRequestSchema);
      const tokens = yield* dependencies.authService.refresh({
        config: dependencies.authConfig,
        now: dependencies.now(),
        refreshToken: input.refreshToken,
      });
      return {
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: toIso(tokens.accessExpiresAt),
        refreshToken: tokens.refreshToken,
      };
    });
    return runRouteEffect(context, correlationId, program, (tokens) =>
      context.json(decodeAuthTokensEnvelope(successEnvelopeInput(tokens, correlationId))),
    );
  });
};

const registerLogoutRoute = (routes: Hono, dependencies: AuthRouteDependencies) => {
  routes.post("/v1/auth/logout", logoutDocumentation, async (context) => {
    const correlationId = beginRequest(context, dependencies.createCorrelationId);
    const program = Effect.gen(function* () {
      const accessToken = yield* requireBearerToken(context.req.header("authorization"));
      yield* dependencies.authService.logout({
        accessToken,
        now: dependencies.now(),
      });
      return { revoked: true as const };
    });
    return runRouteEffect(context, correlationId, program, (result) =>
      context.json(decodeLogoutEnvelope(successEnvelopeInput(result, correlationId))),
    );
  });
};

const registerStatusRoute = (routes: Hono, dependencies: AuthRouteDependencies) => {
  routes.get("/v1/auth/status", authStatusDocumentation, async (context) => {
    const correlationId = beginRequest(context, dependencies.createCorrelationId);
    const program = Effect.gen(function* () {
      const token = yield* optionalBearerToken(context.req.header("authorization"));
      if (token === null) return { authenticated: false as const };
      const identity = yield* dependencies.authService.lookupAccess({
        accessToken: token,
        now: dependencies.now(),
      });
      const billing = yield* dependencies.billingService.getEntitlement({
        now: dependencies.now(),
        priceIds: dependencies.priceIds,
        userId: identity.userId,
      });
      return {
        authenticated: true as const,
        sessionExpiresAt: toIso(identity.accessExpiresAt),
        user: {
          email: identity.email,
          id: identity.userId,
          plan: billing.entitlements.plan,
        },
      };
    });
    return runRouteEffect(context, correlationId, program, (status) =>
      context.json(decodeAuthStatusEnvelope(successEnvelopeInput(status, correlationId))),
    );
  });
};

const toIso = (timestamp: number) => new Date(timestamp).toISOString();
