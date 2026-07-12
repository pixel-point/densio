import { Effect, Result, Schema } from "effect";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import type { AuthService } from "../auth/auth-service.ts";
import { ApiProblem, makeProblem, toProblemDetails } from "../errors/problem-details.ts";
import { RangeNotSatisfiable } from "../storage/byte-range.ts";
import { authRequiredProblem } from "./problems/auth-problems.ts";
import {
  classifyRouteFailure,
  reportRouteFailure,
  type RouteFailureReporter,
} from "./route-failure.ts";

export type { RouteFailureReport } from "./route-failure.ts";

const BearerHeaderSchema = Schema.String.check(Schema.isPattern(/^Bearer\s+\S+$/i));
const NonEmptyHeaderSchema = Schema.NonEmptyString;
const maximumJsonBytes = 65_536;

const decodeBearerHeader = Schema.decodeUnknownEffect(BearerHeaderSchema);
const decodeNonEmptyHeader = Schema.decodeUnknownEffect(NonEmptyHeaderSchema);

export const beginRequest = (context: Context, createCorrelationId: () => string) => {
  const correlationId = createCorrelationId();
  context.header("x-correlation-id", correlationId);
  return correlationId;
};

export const decodeRequestJson = Effect.fn("Routes.decodeRequestJson")(
  <S extends Schema.Top>(request: Request, schema: S) =>
    Effect.tryPromise({
      catch: (cause) => (cause instanceof ApiProblem ? cause : invalidRequestProblem()),
      try: () => readJsonBody(request),
    }).pipe(
      Effect.flatMap((body) =>
        Schema.decodeUnknownEffect(schema)(body).pipe(
          Effect.mapError(() => invalidRequestProblem()),
        ),
      ),
    ),
);

export const requireBearerToken = Effect.fn("Routes.requireBearerToken")(
  (authorization: string | undefined) =>
    decodeBearerHeader(authorization).pipe(
      Effect.map((header) => header.replace(/^Bearer\s+/i, "")),
      Effect.mapError(() => authRequiredProblem()),
    ),
);

export const optionalBearerToken = Effect.fn("Routes.optionalBearerToken")(
  (authorization: string | undefined) =>
    authorization === undefined
      ? Effect.succeed<string | null>(null)
      : requireBearerToken(authorization).pipe(Effect.map((token): string | null => token)),
);

export const requireHeader = Effect.fn("Routes.requireHeader")((value: string | undefined) =>
  decodeNonEmptyHeader(value).pipe(Effect.mapError(() => invalidRequestProblem())),
);

export const authenticateRequest = Effect.fn("Routes.authenticateRequest")(function* (
  request: Request,
  authService: AuthService["Service"],
  now: number,
) {
  const accessToken = yield* requireBearerToken(request.headers.get("authorization") ?? undefined);
  return yield* authService.lookupAccess({ accessToken, now });
});

export const readRawBody = Effect.fn("Routes.readRawBody")((request: Request) =>
  Effect.tryPromise({
    catch: () => invalidRequestProblem(),
    try: async () => new Uint8Array(await request.arrayBuffer()),
  }),
);

export const successEnvelopeInput = <Value>(data: Value, correlationId: string) =>
  ({
    correlationId,
    data,
    ok: true,
    schemaVersion: 1,
  }) as const;

export const runRouteEffect = async <Value, Error>(
  context: Context,
  correlationId: string,
  effect: Effect.Effect<Value, Error>,
  onSuccess: (value: Value) => Response | Promise<Response>,
  reportInternalFailure: RouteFailureReporter = reportRouteFailure,
) => {
  const result = await Effect.runPromise(Effect.result(effect));
  if (Result.isFailure(result)) {
    const failure = classifyRouteFailure(result.failure, correlationId);
    if (failure.report !== undefined) {
      await Promise.resolve(reportInternalFailure(failure.report)).then(
        () => undefined,
        () => undefined,
      );
    }
    return problemResponse(context, failure.problem, correlationId, problemHeaders(result.failure));
  }
  return onSuccess(result.success);
};

const problemResponse = (
  context: Context,
  problem: ApiProblem,
  correlationId: string,
  headers: Readonly<Record<string, string>>,
) =>
  context.json(toProblemDetails(problem, correlationId), problem.status as ContentfulStatusCode, {
    "content-type": "application/problem+json",
    ...headers,
  });

const problemHeaders = (error: unknown) =>
  error instanceof RangeNotSatisfiable ? { "content-range": error.contentRange } : {};

export const invalidRequestProblem = () =>
  makeProblem({
    code: "INVALID_REQUEST",
    detail: "The request body or required header is invalid.",
    retryable: false,
    status: 400,
    suggestedAction: "Correct the request using the documented JSON schema.",
    title: "Invalid request",
  });

const requestTooLargeProblem = () =>
  makeProblem({
    code: "REQUEST_TOO_LARGE",
    detail: `JSON request bodies are limited to ${maximumJsonBytes} bytes.`,
    retryable: false,
    status: 413,
    suggestedAction: "Remove unsupported or oversized request fields and retry.",
    title: "Request body too large",
  });

const readJsonBody = async (request: Request): Promise<unknown> => {
  const declaredBytes = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > maximumJsonBytes) {
    throw requestTooLargeProblem();
  }
  if (request.body === null) throw invalidRequestProblem();

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumJsonBytes) {
        await reader.cancel();
        throw requestTooLargeProblem();
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } finally {
    reader.releaseLock();
  }
};
