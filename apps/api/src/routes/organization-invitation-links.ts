import {
  OrganizationInvitationLinkRequestSchema,
  OrganizationInvitationLinkResponseSchema,
  successEnvelope,
} from "@densio/shared";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { OrganizationInvitationLinkService } from "../organizations/organization-invitation-link-service.ts";
import {
  makeDescriptorProblem,
  requestTooLargeProblemDescriptor,
  toProblemDetails,
} from "../errors/problem-details.ts";
import {
  beginRequest,
  decodeRequestJson,
  invalidRequestProblem,
  runRouteEffect,
  successEnvelopeInput,
} from "./route-support.ts";
import { invitationLinkDocumentation } from "./organization-invitation-link-documentation.ts";

export interface OrganizationInvitationLinkRouteDependencies {
  readonly invitationLinkService: OrganizationInvitationLinkService;
  readonly websiteBaseUrl?: string;
  readonly now: () => number;
  readonly createCorrelationId: () => string;
}
const path = "/v1/organization-invitations/link";
const legacyPath = "/v1/organization-invitations/confirm";
const decodeResponse = Schema.decodeUnknownSync(
  successEnvelope(OrganizationInvitationLinkResponseSchema),
);

export const createOrganizationInvitationLinkRoutes = (
  dependencies: OrganizationInvitationLinkRouteDependencies,
) => {
  const routes = new Hono();
  [path, legacyPath].forEach((route) =>
    routes.use(route, async (context, next) => {
      context.header("cache-control", "no-store");
      context.header("referrer-policy", "no-referrer");
      await next();
    }),
  );
  const limitBody = bodyLimit({
    maxSize: 4096,
    onError: (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const problem = makeDescriptorProblem(requestTooLargeProblemDescriptor, {
        detail: "Invitation requests are limited to 4096 bytes.",
        retryable: false,
        suggestedAction: "Open the original invitation link.",
      });
      return context.json(toProblemDetails(problem, correlationId), 413, {
        "content-type": "application/problem+json",
      });
    },
  });
  [path, legacyPath].forEach((route) =>
    routes.use(route, (context, next) =>
      context.req.method === "POST" ? limitBody(context, next) : next(),
    ),
  );
  routes.get(path, invitationLinkDocumentation(false), (context) => {
    const correlationId = beginRequest(context, dependencies.createCorrelationId);
    const program = Effect.gen(function* () {
      const input = yield* decodeLinkInput(context.req.query());
      return yield* dependencies.invitationLinkService.inspect({
        ...input,
        now: dependencies.now(),
      });
    });
    return runRouteEffect(context, correlationId, program, (result) =>
      context.json(decodeResponse(successEnvelopeInput(result, correlationId))),
    );
  });
  routes.post(path, invitationLinkDocumentation(true), (context) => {
    const correlationId = beginRequest(context, dependencies.createCorrelationId);
    const program = Effect.gen(function* () {
      const input = yield* decodeRequestJson(
        context.req.raw,
        OrganizationInvitationLinkRequestSchema,
      );
      yield* dependencies.invitationLinkService.accept({
        ...input,
        now: dependencies.now(),
        correlationId,
      });
      return yield* dependencies.invitationLinkService.inspect({
        ...input,
        now: dependencies.now(),
      });
    });
    return runRouteEffect(context, correlationId, program, (result) =>
      context.json(decodeResponse(successEnvelopeInput(result, correlationId))),
    );
  });
  routes.get(legacyPath, invitationLinkDocumentation(false, true), (context) =>
    context.redirect(invitationWebsiteUrl(dependencies, context.req.query("token") ?? ""), 303),
  );
  routes.post(legacyPath, invitationLinkDocumentation(true, true), (context) => {
    const correlationId = beginRequest(context, dependencies.createCorrelationId);
    const program = Effect.gen(function* () {
      const input = yield* decodeLinkForm(context.req.raw);
      yield* dependencies.invitationLinkService.accept({
        ...input,
        now: dependencies.now(),
        correlationId,
      });
      return invitationWebsiteUrl(dependencies, input.token);
    });
    return runRouteEffect(context, correlationId, program, (url) => context.redirect(url, 303));
  });
  return routes;
};
const invitationWebsiteUrl = (
  dependencies: OrganizationInvitationLinkRouteDependencies,
  token: string,
) => {
  const id = token.split(".")[0] || "invalid";
  const url = new URL(
    `/invites/${encodeURIComponent(id)}`,
    dependencies.websiteBaseUrl ?? "http://localhost:3001",
  );
  url.searchParams.set("token", token);
  return url.toString();
};
const decodeLinkInput = Effect.fn("InvitationLink.decodeInput")((input: unknown) =>
  Schema.decodeUnknownEffect(OrganizationInvitationLinkRequestSchema, {
    onExcessProperty: "error",
  })(input).pipe(Effect.mapError(() => invalidRequestProblem())),
);
const decodeLinkForm = Effect.fn("InvitationLink.decodeForm")(function* (request: Request) {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/x-www-form-urlencoded"
  )
    return yield* invalidRequestProblem();
  const text = yield* Effect.tryPromise({
    try: () => request.text(),
    catch: () => invalidRequestProblem(),
  });
  const form = new URLSearchParams(text);
  if (form.getAll("token").length !== 1) return yield* invalidRequestProblem();
  return yield* decodeLinkInput(Object.fromEntries(form));
});
