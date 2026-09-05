import { Effect, Schema } from "effect";
import type { Context } from "hono";
import { describeRoute } from "hono-openapi";
import { successEnvelope, type OrganizationOperation } from "@densio/shared";
import type { AuthService } from "../auth/auth-service.ts";
import type { OrganizationService } from "../organizations/organization-service.ts";
import type { OrganizationErrorCode } from "../organizations/organization-errors.ts";
import {
  internalErrorProblemDescriptor,
  invalidRequestProblemDescriptor,
  requestTooLargeProblemDescriptor,
} from "../errors/problem-details.ts";
import {
  bearerSecurity,
  jsonRequest,
  pathParameter,
  problemResponses,
  queryParameters,
  successResponse,
} from "./openapi-support.ts";
import { authRequiredProblemDescriptor } from "./problems/auth-problems.ts";
import { organizationProblemDescriptor } from "./problems/organization-problems.ts";
import {
  authenticateRequest,
  invalidRequestProblem,
  successEnvelopeInput,
} from "./route-support.ts";

export interface OrganizationRouteDependencies {
  readonly authService: AuthService["Service"];
  readonly organizationService: OrganizationService;
  readonly now: () => number;
  readonly createCorrelationId: () => string;
  readonly maxCreatesPerDay: number;
  readonly publicBaseUrl: string;
}

export const organizationRouteActor = Effect.fn("OrganizationRoutes.actor")(function* (
  context: Context,
  dependencies: Pick<OrganizationRouteDependencies, "authService" | "organizationService" | "now">,
  operation: OrganizationOperation,
  allowClosed = false,
) {
  const identity = yield* authenticateRequest(
    context.req.raw,
    dependencies.authService,
    dependencies.now(),
  );
  return yield* dependencies.organizationService.authorize(
    { organizationId: context.req.param("organizationId") ?? "", userId: identity.userId },
    operation,
    allowClosed,
  );
});

export const organizationQuery = Effect.fn("OrganizationRoutes.query")(<S extends Schema.Top>(
  context: Context,
  schema: S,
) => {
  const query = context.req.query();
  const values = Object.fromEntries(
    Object.entries(query).map(([key, value]) => [
      key,
      key === "limit" || key === "after" ? Number(value) : value,
    ]),
  );
  return Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(values).pipe(
    Effect.mapError(() => invalidRequestProblem()),
  );
});

export const organizationResponse = <S extends Schema.Top & Schema.ConstraintDecoder<unknown>>(
  context: Context,
  schema: S,
  value: unknown,
  correlationId: string,
  status: 200 | 201 | 202 = 200,
) =>
  context.json(
    Schema.decodeUnknownSync(successEnvelope(schema))(successEnvelopeInput(value, correlationId)),
    status,
  );

export const organizationRouteDocumentation = (input: {
  operationId: string;
  summary: string;
  response: Schema.Top;
  request?: Schema.Top;
  parameters?: ReturnType<typeof pathParameter>[];
  errors?: readonly OrganizationErrorCode[];
  created?: boolean;
  query?: Schema.Struct<Schema.Struct.Fields>;
}) =>
  describeRoute({
    operationId: input.operationId,
    summary: input.summary,
    tags: ["Organizations"],
    security: bearerSecurity,
    ...(input.request === undefined ? {} : { requestBody: jsonRequest(input.request) }),
    parameters: [
      ...(input.parameters ?? []),
      ...(input.query === undefined
        ? []
        : queryParameters(input.query, {
            limit: "Maximum results, 1–100; defaults to 25 (audit events: 100).",
            cursor: "Opaque continuation cursor from this same organization and query.",
            state: "Restrict results to this lifecycle state.",
            after: "Exclusive audit sequence; defaults to 0.",
          })),
    ],
    responses: {
      [input.created === true ? "201" : "200"]: successResponse(input.summary, input.response),
      ...(input.created === true
        ? {
            "200": successResponse(
              "The original organization creation was replayed.",
              input.response,
            ),
          }
        : {}),
      ...problemResponses(
        authRequiredProblemDescriptor,
        internalErrorProblemDescriptor,
        ...(input.request === undefined
          ? []
          : [invalidRequestProblemDescriptor, requestTooLargeProblemDescriptor]),
        ...(input.query === undefined ? [] : [invalidRequestProblemDescriptor]),
        ...(input.errors ?? []).map(organizationProblemDescriptor),
      ),
    },
  });

export const organizationPathParameter = pathParameter(
  "organizationId",
  "Explicit organization ID; no implicit default selection.",
);
export const organizationReadErrors = [
  "ORGANIZATION_NOT_FOUND",
  "ORGANIZATION_ACCESS_DENIED",
  "ORGANIZATION_NOT_ACTIVE",
] as const;
