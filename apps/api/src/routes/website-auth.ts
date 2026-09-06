import {
  AuthConfirmRequestSchema,
  AuthConfirmResponseSchema,
  AuthPollRequestSchema,
  BrowserAuthConfirmRequestSchema,
  BrowserAuthConfirmResponseSchema,
  BrowserAuthPollResponseSchema,
  successEnvelope,
} from "@densio/shared";
import { Effect, Schema } from "effect";
import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import type { AuthRouteDependencies } from "./auth.ts";
import {
  beginRequest,
  decodeRequestJson,
  runRouteEffect,
  successEnvelopeInput,
} from "./route-support.ts";
import {
  jsonRequest,
  problemResponses,
  queryParameter,
  successResponse,
} from "./openapi-support.ts";
import {
  internalErrorProblemDescriptor,
  invalidRequestProblemDescriptor,
  requestTooLargeProblemDescriptor,
} from "../errors/problem-details.ts";
import {
  authChallengeExpiredProblemDescriptor,
  authChallengeInvalidProblemDescriptor,
  authChallengeUsedProblemDescriptor,
} from "./problems/auth-problems.ts";

const errors = problemResponses(
  invalidRequestProblemDescriptor,
  authChallengeInvalidProblemDescriptor,
  authChallengeUsedProblemDescriptor,
  authChallengeExpiredProblemDescriptor,
  requestTooLargeProblemDescriptor,
  internalErrorProblemDescriptor,
);
const decodeConfirmation = Schema.decodeUnknownSync(successEnvelope(AuthConfirmResponseSchema));
const decodeBrowser = Schema.decodeUnknownSync(successEnvelope(BrowserAuthPollResponseSchema));
const decodeBrowserConfirmation = Schema.decodeUnknownSync(
  successEnvelope(BrowserAuthConfirmResponseSchema),
);

export const registerWebsiteAuthRoutes = (routes: Hono, dependencies: AuthRouteDependencies) => {
  registerBrowserConfirmation(routes, dependencies);
  routes.get(
    "/v1/auth/confirm",
    describeRoute({
      operationId: "redirectLoginConfirmation",
      summary: "Open the website login confirmation",
      tags: ["Authentication"],
      parameters: [queryParameter("token", "Magic-link confirmation token.", true)],
      responses: {
        "303": { description: "Continue on the website without consuming the challenge." },
      },
    }),
    (context) => {
      const url = new URL(
        "/auth/confirm",
        dependencies.authConfig.websiteBaseUrl ?? dependencies.authConfig.publicBaseUrl,
      );
      url.searchParams.set("token", context.req.query("token") ?? "");
      context.header("cache-control", "no-store");
      context.header("referrer-policy", "no-referrer");
      return context.redirect(url.toString(), 303);
    },
  );
  routes.post(
    "/v1/auth/confirm",
    describeRoute({
      operationId: "confirmLogin",
      summary: "Confirm an emailed login request",
      tags: ["Authentication"],
      requestBody: jsonRequest(AuthConfirmRequestSchema),
      responses: {
        "200": successResponse("The login challenge was confirmed.", AuthConfirmResponseSchema),
        ...errors,
      },
    }),
    (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const program = Effect.gen(function* () {
        const input = yield* decodeRequestJson(context.req.raw, AuthConfirmRequestSchema);
        return yield* dependencies.authService.confirm({
          confirmationToken: input.token,
          now: dependencies.now(),
        });
      });
      return runRouteEffect(context, correlationId, program, (result) =>
        context.json(decodeConfirmation(successEnvelopeInput(result, correlationId))),
      );
    },
  );
  routes.post(
    "/v1/auth/browser/poll",
    describeRoute({
      operationId: "pollBrowserLogin",
      summary: "Exchange a confirmed login request for a browser session",
      description:
        "Issues an opaque bearer session with the API-configured absolute session lifetime. Revoke it with the logout endpoint. No refresh credential is exposed.",
      tags: ["Authentication"],
      requestBody: jsonRequest(AuthPollRequestSchema),
      responses: {
        "200": successResponse(
          "The request is pending or a browser session was issued.",
          BrowserAuthPollResponseSchema,
        ),
        ...errors,
      },
    }),
    (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const program = Effect.gen(function* () {
        const input = yield* decodeRequestJson(context.req.raw, AuthPollRequestSchema);
        const result = yield* dependencies.authService.pollBrowser({
          config: dependencies.authConfig,
          now: dependencies.now(),
          pollingToken: input.pollToken,
        });
        return {
          ...result,
          expiresAt: new Date(result.expiresAt).toISOString(),
          ...(result.status === "pending"
            ? { pollAfterSeconds: dependencies.pollAfterSeconds }
            : {}),
        };
      });
      return runRouteEffect(context, correlationId, program, (result) =>
        context.json(decodeBrowser(successEnvelopeInput(result, correlationId))),
      );
    },
  );
};

const registerBrowserConfirmation = (routes: Hono, dependencies: AuthRouteDependencies) => {
  routes.post(
    "/v1/auth/browser/confirm",
    describeRoute({
      operationId: "confirmBrowserLogin",
      summary: "Confirm a browser login and issue its session atomically",
      description:
        "Requires the email token and the initiating browser's polling secret for the same challenge. Returns only an opaque browser session with the API-configured absolute lifetime.",
      tags: ["Authentication"],
      requestBody: jsonRequest(BrowserAuthConfirmRequestSchema),
      responses: {
        "200": successResponse(
          "The login was confirmed and a browser session was issued.",
          BrowserAuthConfirmResponseSchema,
        ),
        ...errors,
      },
    }),
    (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const program = Effect.gen(function* () {
        const input = yield* decodeRequestJson(context.req.raw, BrowserAuthConfirmRequestSchema);
        const result = yield* dependencies.authService.confirmBrowser({
          config: dependencies.authConfig,
          confirmationToken: input.token,
          pollingToken: input.pollToken,
          now: dependencies.now(),
        });
        return { ...result, expiresAt: new Date(result.expiresAt).toISOString() };
      });
      return runRouteEffect(context, correlationId, program, (result) =>
        context.json(decodeBrowserConfirmation(successEnvelopeInput(result, correlationId))),
      );
    },
  );
};
