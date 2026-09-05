import { OrganizationInvitationLinkRequestSchema } from "@densio/shared";
import { Effect, Result, Schema } from "effect";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { OrganizationInvitationLinkService } from "../organizations/organization-invitation-link-service.ts";
import { beginRequest, invalidRequestProblem } from "./route-support.ts";
import { classifyRouteFailure, reportRouteFailure } from "./route-failure.ts";
import {
  invitationAcceptedPage,
  invitationConfirmationPage,
  invitationFailurePage,
} from "./organization-invitation-page.ts";
import { invitationLinkDocumentation } from "./organization-invitation-link-documentation.ts";

export interface OrganizationInvitationLinkRouteDependencies {
  readonly invitationLinkService: OrganizationInvitationLinkService;
  readonly now: () => number;
  readonly createCorrelationId: () => string;
}
const path = "/v1/organization-invitations/confirm";

export const createOrganizationInvitationLinkRoutes = (
  dependencies: OrganizationInvitationLinkRouteDependencies,
) => {
  const routes = new Hono();
  routes.use(path, async (context, next) => {
    context.header("cache-control", "no-store");
    context.header("referrer-policy", "no-referrer");
    context.header(
      "content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    context.header("x-content-type-options", "nosniff");
    context.header("x-frame-options", "DENY");
    await next();
  });
  routes.get(path, invitationLinkDocumentation(false), (context) => {
    const correlationId = beginRequest(context, dependencies.createCorrelationId);
    const program = Effect.gen(function* () {
      const input = yield* decodeLinkInput(context.req.query());
      const invitation = yield* dependencies.invitationLinkService.inspect({
        ...input,
        now: dependencies.now(),
      });
      return invitation.accepted
        ? invitationAcceptedPage(invitation.name)
        : invitationConfirmationPage({ ...invitation, token: input.token });
    });
    return runInvitationPage(context, correlationId, program);
  });
  routes.post(
    path,
    invitationLinkDocumentation(true),
    bodyLimit({
      maxSize: 4096,
      onError: (context) =>
        context.html(
          invitationFailurePage(
            "Invalid invitation request",
            "The submitted form is too large. Open the original invitation link.",
          ),
          413,
        ),
    }),
    (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const program = Effect.gen(function* () {
        const input = yield* decodeLinkForm(context.req.raw);
        const name = yield* dependencies.invitationLinkService.accept({
          ...input,
          now: dependencies.now(),
          correlationId,
        });
        return invitationAcceptedPage(name);
      });
      return runInvitationPage(context, correlationId, program);
    },
  );
  return routes;
};

const decodeLinkInput = Effect.fn("InvitationPage.decodeInput")((input: unknown) =>
  Schema.decodeUnknownEffect(OrganizationInvitationLinkRequestSchema, {
    onExcessProperty: "error",
  })(input).pipe(Effect.mapError(() => invalidRequestProblem())),
);

const decodeLinkForm = Effect.fn("InvitationPage.decodeForm")(function* (request: Request) {
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

const runInvitationPage = async <Error>(
  context: Context,
  correlationId: string,
  program: Effect.Effect<ReturnType<typeof invitationConfirmationPage>, Error>,
) => {
  const result = await Effect.runPromise(Effect.result(program));
  if (Result.isSuccess(result)) return context.html(result.success);
  const failure = classifyRouteFailure(result.failure, correlationId);
  if (failure.report !== undefined) {
    await Promise.resolve(reportRouteFailure(failure.report)).then(
      () => undefined,
      () => undefined,
    );
  }
  const detail =
    failure.problem.status === 400
      ? "Open the original invitation link and try again."
      : failure.problem.detail;
  return context.html(
    invitationFailurePage(failure.problem.title, detail),
    failure.problem.status as ContentfulStatusCode,
  );
};
