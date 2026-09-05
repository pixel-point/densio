import type { makeSourceUploadService } from "../storage/uploads/source-upload-service.ts";
import type { streamGrantedHls } from "../videos/hls-download.ts";
import type { streamGrantedVideo } from "../videos/video-stream.ts";
import { JobIdempotencyKeySchema } from "@densio/shared";
import { Effect, Schema } from "effect";
import { Hono, type Context } from "hono";
import { describeRoute } from "hono-openapi";
import type { AuthService } from "../auth/auth-service.ts";
import type { OrganizationService } from "../organizations/organization-service.ts";
import type { OrganizationActor } from "../organizations/organization-access.ts";
import type { makeVideoService } from "../videos/video-service.ts";
import type { makeStorageConnectionService } from "../storage/connections/connection-service.ts";
import {
  bearerSecurity,
  headerParameter,
  jsonRequest,
  pathParameter,
  problemResponses,
  queryParameters,
  successResponse,
} from "./openapi-support.ts";
import {
  beginRequest,
  decodeRequestJson,
  invalidRequestProblem,
  runRouteEffect,
} from "./route-support.ts";
import {
  organizationPathParameter,
  organizationReadErrors,
  organizationResponse,
  organizationRouteActor,
} from "./organization-route-support.ts";
import { organizationProblemDescriptor } from "./problems/organization-problems.ts";
import { authRequiredProblemDescriptor } from "./problems/auth-problems.ts";
import {
  invalidRequestProblemDescriptor,
  requestTooLargeProblemDescriptor,
} from "../errors/problem-details.ts";
import { videoStorageProblemDescriptors } from "./problems/video-storage-problems.ts";

export interface StorageRouteDependencies {
  readonly sourceUploads?: ReturnType<typeof makeSourceUploadService>;
  readonly download?: (
    input: Parameters<typeof streamGrantedVideo>[2],
  ) => ReturnType<typeof streamGrantedVideo>;
  readonly downloadPackage?: (
    input: Parameters<typeof streamGrantedHls>[2],
  ) => ReturnType<typeof streamGrantedHls>;
  readonly authService: AuthService["Service"];
  readonly organizationService: OrganizationService;
  readonly now: () => number;
  readonly createCorrelationId: () => string;
  readonly videoService: ReturnType<typeof makeVideoService>;
  readonly connectionService: ReturnType<typeof makeStorageConnectionService>;
}
export const storageIdempotency = (context: Context) =>
  Schema.decodeUnknownEffect(JobIdempotencyKeySchema)(context.req.header("idempotency-key")).pipe(
    Effect.mapError(() => invalidRequestProblem()),
  );

export const registerStorageRoute = <
  S extends Schema.Top & Schema.ConstraintDecoder<unknown, never>,
>(
  routes: Hono,
  dependencies: StorageRouteDependencies,
  definition: {
    readonly method: "get" | "post" | "patch" | "delete";
    readonly path: string;
    readonly operationId: string;
    readonly summary: string;
    readonly request: S;
    readonly response: Schema.Top & Schema.ConstraintDecoder<unknown>;
    readonly body?: boolean;
    readonly query?: (context: Context) => unknown;
    readonly parameters?: ReturnType<typeof queryParameters>;
    readonly allowClosed?: boolean;
    readonly created?: 201 | 202;
    readonly idempotent?: boolean;
    readonly handle: (
      actor: OrganizationActor,
      request: S["Type"],
      context: Context,
    ) => Effect.Effect<unknown, unknown>;
  },
) => {
  routes[definition.method](
    definition.path,
    describeRoute({
      operationId: definition.operationId,
      summary: definition.summary,
      tags: ["Video storage"],
      security: bearerSecurity,
      ...(definition.body ? { requestBody: jsonRequest(definition.request) } : {}),
      parameters: [
        organizationPathParameter,
        ...(definition.parameters ?? []),
        ...storagePathParameters(definition.path),
        ...(definition.idempotent
          ? [
              headerParameter(
                "idempotency-key",
                "Replay key for this exact intent",
                true,
                JobIdempotencyKeySchema,
              ),
            ]
          : []),
      ],
      responses: {
        "200": successResponse("Current state or completed replay", definition.response),
        ...(definition.created
          ? { [definition.created]: successResponse(definition.summary, definition.response) }
          : {}),
        ...problemResponses(
          authRequiredProblemDescriptor,
          invalidRequestProblemDescriptor,
          requestTooLargeProblemDescriptor,
          ...organizationReadErrors.map(organizationProblemDescriptor),
          ...videoStorageProblemDescriptors,
        ),
      },
    }),
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      context.header("cache-control", "no-store");
      const program = Effect.gen(function* () {
        const actor = yield* organizationRouteActor(
          context,
          dependencies,
          "media-read",
          definition.allowClosed ?? false,
        );
        const input = definition.body
          ? yield* decodeRequestJson(context.req.raw, definition.request)
          : yield* Schema.decodeUnknownEffect(definition.request)(
              definition.query?.(context) ?? {},
            ).pipe(Effect.mapError(() => invalidRequestProblem()));
        if (definition.idempotent) yield* storageIdempotency(context);
        return yield* definition.handle(actor, input, context);
      });
      return runRouteEffect(context, correlationId, program, (result) =>
        organizationResponse(
          context,
          definition.response,
          result,
          correlationId,
          definition.created &&
            !(
              result !== null &&
              typeof result === "object" &&
              "replayed" in result &&
              result.replayed === true
            )
            ? definition.created
            : 200,
        ),
      );
    },
  );
};

const storagePathParameters = (path: string) =>
  [...path.matchAll(/:([a-zA-Z]+Id)/g)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined && name !== "organizationId")
    .map((name) => pathParameter(name, `Owned ${name}`));
