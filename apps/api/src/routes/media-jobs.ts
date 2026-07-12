import {
  CompressionJobRequestSchema,
  ExtractImagesJobRequestSchema,
  JobCreatedResponseSchema,
  JobStatusSchema,
  QualityComparisonJobRequestSchema,
  UploadCompletedResponseSchema,
  type CompressionJobRequest,
  type ExtractImagesJobRequest,
  type JobWorkflow,
  type QualityComparisonJobRequest,
  successEnvelope,
} from "@ffmpeg-api/shared";
import { Effect, Schema } from "effect";
import { Hono } from "hono";

import type { AuthService } from "../auth/auth-service.ts";
import type { BillingService } from "../billing/billing-service.ts";
import type { makeJobService } from "../jobs/job-service.ts";
import {
  authenticateRequest,
  beginRequest,
  decodeRequestJson,
  invalidRequestProblem,
  runRouteEffect,
  successEnvelopeInput,
} from "./route-support.ts";

const IdempotencyKeySchema = Schema.NonEmptyString.check(Schema.isMaxLength(200));
const decodeIdempotencyKey = Schema.decodeUnknownEffect(IdempotencyKeySchema);
const decodeCreatedEnvelope = Schema.decodeUnknownSync(successEnvelope(JobCreatedResponseSchema));
const decodeUploadedEnvelope = Schema.decodeUnknownSync(
  successEnvelope(UploadCompletedResponseSchema),
);
const decodeStatusEnvelope = Schema.decodeUnknownSync(successEnvelope(JobStatusSchema));

type MediaJobRequest =
  | CompressionJobRequest
  | ExtractImagesJobRequest
  | QualityComparisonJobRequest;

export interface MediaJobRouteDependencies {
  readonly authService: AuthService["Service"];
  readonly billingService: BillingService["Service"];
  readonly createCorrelationId: () => string;
  readonly jobService: ReturnType<typeof makeJobService>;
  readonly now: () => number;
  readonly proPriceId: string;
}

export const createMediaJobRoutes = (dependencies: MediaJobRouteDependencies) => {
  const routes = new Hono();
  registerCompressionRoute(routes, dependencies);
  registerExtractionRoute(routes, dependencies);
  registerComparisonRoute(routes, dependencies);
  registerUploadRoute(routes, dependencies);
  registerStatusRoute(routes, dependencies);
  registerCancellationRoute(routes, dependencies);
  return routes;
};

const registerCompressionRoute = (routes: Hono, dependencies: MediaJobRouteDependencies) => {
  routes.post("/v1/compress", async (context) => {
    const correlationId = beginRequest(context, dependencies.createCorrelationId);
    const program = Effect.gen(function* () {
      const input = yield* decodeRequestJson(context.req.raw, CompressionJobRequestSchema);
      return yield* createOwnedJob(dependencies, context.req.raw, input, "compress");
    });
    return runRouteEffect(context, correlationId, program, (created) =>
      context.json(decodeCreatedEnvelope(successEnvelopeInput(created, correlationId)), 201),
    );
  });
};

const registerExtractionRoute = (routes: Hono, dependencies: MediaJobRouteDependencies) => {
  routes.post("/v1/extract-images", async (context) => {
    const correlationId = beginRequest(context, dependencies.createCorrelationId);
    const program = Effect.gen(function* () {
      const input = yield* decodeRequestJson(context.req.raw, ExtractImagesJobRequestSchema);
      return yield* createOwnedJob(dependencies, context.req.raw, input, "extract-images");
    });
    return runRouteEffect(context, correlationId, program, (created) =>
      context.json(decodeCreatedEnvelope(successEnvelopeInput(created, correlationId)), 201),
    );
  });
};

const registerComparisonRoute = (routes: Hono, dependencies: MediaJobRouteDependencies) => {
  routes.post("/v1/compare-quality", async (context) => {
    const correlationId = beginRequest(context, dependencies.createCorrelationId);
    const program = Effect.gen(function* () {
      const input = yield* decodeRequestJson(context.req.raw, QualityComparisonJobRequestSchema);
      return yield* createOwnedJob(dependencies, context.req.raw, input, "compare-quality");
    });
    return runRouteEffect(context, correlationId, program, (created) =>
      context.json(decodeCreatedEnvelope(successEnvelopeInput(created, correlationId)), 201),
    );
  });
};

const createOwnedJob = Effect.fn("MediaRoutes.createJob")(function* (
  dependencies: MediaJobRouteDependencies,
  request: Request,
  input: MediaJobRequest,
  workflow: JobWorkflow,
) {
  const now = dependencies.now();
  const identity = yield* authenticateRequest(request, dependencies.authService, now);
  const billing = yield* dependencies.billingService.getEntitlement({
    proPriceId: dependencies.proPriceId,
    userId: identity.userId,
  });
  const idempotencyKey = yield* optionalIdempotencyKey(
    request.headers.get("idempotency-key") ?? undefined,
  );
  return yield* dependencies.jobService.create({
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    now,
    options: input.options ?? {},
    plan: billing.entitlements.plan,
    source: input.source,
    userId: identity.userId,
    workflow,
  });
});

const registerUploadRoute = (routes: Hono, dependencies: MediaJobRouteDependencies) => {
  routes.put("/v1/jobs/:id/upload", async (context) => {
    const correlationId = beginRequest(context, dependencies.createCorrelationId);
    const now = dependencies.now();
    const program = Effect.gen(function* () {
      const identity = yield* authenticateRequest(context.req.raw, dependencies.authService, now);
      const body = context.req.raw.body;
      if (body === null) return yield* invalidRequestProblem();
      return yield* dependencies.jobService.upload({
        body,
        jobId: context.req.param("id"),
        now,
        userId: identity.userId,
      });
    });
    return runRouteEffect(context, correlationId, program, (uploaded) =>
      context.json(decodeUploadedEnvelope(successEnvelopeInput(uploaded, correlationId))),
    );
  });
};

const registerStatusRoute = (routes: Hono, dependencies: MediaJobRouteDependencies) => {
  routes.get("/v1/jobs/:id", async (context) => {
    const correlationId = beginRequest(context, dependencies.createCorrelationId);
    const now = dependencies.now();
    const program = Effect.gen(function* () {
      const identity = yield* authenticateRequest(context.req.raw, dependencies.authService, now);
      return yield* dependencies.jobService.status({
        correlationId,
        jobId: context.req.param("id"),
        userId: identity.userId,
      });
    });
    return runRouteEffect(context, correlationId, program, (status) =>
      context.json(decodeStatusEnvelope(successEnvelopeInput(status, correlationId))),
    );
  });
};

const registerCancellationRoute = (routes: Hono, dependencies: MediaJobRouteDependencies) => {
  routes.post("/v1/jobs/:id/cancel", async (context) => {
    const correlationId = beginRequest(context, dependencies.createCorrelationId);
    const now = dependencies.now();
    const program = Effect.gen(function* () {
      const identity = yield* authenticateRequest(context.req.raw, dependencies.authService, now);
      return yield* dependencies.jobService.cancel({
        correlationId,
        jobId: context.req.param("id"),
        now,
        userId: identity.userId,
      });
    });
    return runRouteEffect(context, correlationId, program, (status) =>
      context.json(decodeStatusEnvelope(successEnvelopeInput(status, correlationId))),
    );
  });
};

const optionalIdempotencyKey = Effect.fn("MediaRoutes.idempotencyKey")(
  (value: string | undefined) =>
    value === undefined
      ? Effect.succeed<string | undefined>(undefined)
      : decodeIdempotencyKey(value).pipe(
          Effect.map((key): string | undefined => key),
          Effect.mapError(() => invalidRequestProblem()),
        ),
);
