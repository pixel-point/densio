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
} from "@densio/shared";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";

import type { AuthService } from "../auth/auth-service.ts";
import type { BillingService } from "../billing/billing-service.ts";
import type { BillingPriceIds } from "../billing/billing-repository.ts";
import {
  internalErrorProblemDescriptor,
  invalidRequestProblemDescriptor,
  requestTooLargeProblemDescriptor,
  type ProblemDescriptor,
} from "../errors/problem-details.ts";
import type { makeJobService } from "../jobs/job-service.ts";
import {
  authenticateRequest,
  beginRequest,
  decodeRequestJson,
  invalidRequestProblem,
  runRouteEffect,
  successEnvelopeInput,
} from "./route-support.ts";
import {
  bearerSecurity,
  binaryBody,
  headerParameter,
  jsonRequest,
  pathParameter,
  problemResponses,
  successResponse,
} from "./openapi-support.ts";
import { authRequiredProblemDescriptor } from "./problems/auth-problems.ts";
import { billingUserProblemDescriptor } from "./problems/billing-problems.ts";
import {
  comparisonDurationProblemDescriptor,
  creditsExhaustedProblemDescriptor,
  idempotencyConflictProblemDescriptor,
  jobNotFoundProblemDescriptor,
  jobStateProblemDescriptor,
  uploadExpiredProblemDescriptor,
  uploadLimitProblemDescriptor,
  uploadSizeProblemDescriptor,
} from "./problems/job-problems.ts";

const IdempotencyKeySchema = Schema.NonEmptyString.check(Schema.isMaxLength(200));
const decodeIdempotencyKey = Schema.decodeUnknownEffect(IdempotencyKeySchema);
const decodeCreatedEnvelope = Schema.decodeUnknownSync(successEnvelope(JobCreatedResponseSchema));
const decodeUploadedEnvelope = Schema.decodeUnknownSync(
  successEnvelope(UploadCompletedResponseSchema),
);
const decodeStatusEnvelope = Schema.decodeUnknownSync(successEnvelope(JobStatusSchema));
const compressionDocumentation = jobCreationDocumentation(
  "createCompressionJob",
  "Create a compression job",
  CompressionJobRequestSchema,
);
const extractionDocumentation = jobCreationDocumentation(
  "createImageExtractionJob",
  "Create an image extraction job",
  ExtractImagesJobRequestSchema,
);
const comparisonDocumentation = jobCreationDocumentation(
  "createQualityComparisonJob",
  "Create a quality comparison job",
  QualityComparisonJobRequestSchema,
  comparisonDurationProblemDescriptor,
);
const uploadDocumentation = describeRoute({
  description: "Streams the source bytes for a job that is awaiting upload.",
  operationId: "uploadJobSource",
  parameters: [
    pathParameter("id", "Job identifier."),
    headerParameter("content-length", "Declared upload size in bytes."),
  ],
  requestBody: binaryBody,
  responses: {
    "200": successResponse(
      "The source was stored and the job was queued.",
      UploadCompletedResponseSchema,
    ),
    ...problemResponses(
      invalidRequestProblemDescriptor,
      uploadSizeProblemDescriptor,
      authRequiredProblemDescriptor,
      jobNotFoundProblemDescriptor,
      jobStateProblemDescriptor,
      uploadExpiredProblemDescriptor,
      uploadLimitProblemDescriptor,
      internalErrorProblemDescriptor,
    ),
  },
  security: bearerSecurity,
  summary: "Upload source media",
  tags: ["Media jobs"],
});
const statusDocumentation = describeRoute({
  operationId: "getJobStatus",
  parameters: [pathParameter("id", "Job identifier.")],
  responses: {
    "200": successResponse("The current job state and result, when available.", JobStatusSchema),
    ...problemResponses(
      authRequiredProblemDescriptor,
      jobNotFoundProblemDescriptor,
      internalErrorProblemDescriptor,
    ),
  },
  security: bearerSecurity,
  summary: "Get job status",
  tags: ["Media jobs"],
});
const cancellationDocumentation = describeRoute({
  operationId: "cancelJob",
  parameters: [pathParameter("id", "Job identifier.")],
  responses: {
    "200": successResponse("The updated job state.", JobStatusSchema),
    ...problemResponses(
      authRequiredProblemDescriptor,
      jobNotFoundProblemDescriptor,
      internalErrorProblemDescriptor,
    ),
  },
  security: bearerSecurity,
  summary: "Cancel a job",
  tags: ["Media jobs"],
});

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
  readonly priceIds: BillingPriceIds;
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
  routes.post("/v1/compress", compressionDocumentation, async (context) => {
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
  routes.post("/v1/extract-images", extractionDocumentation, async (context) => {
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
  routes.post("/v1/compare-quality", comparisonDocumentation, async (context) => {
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
    now,
    priceIds: dependencies.priceIds,
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
  routes.put("/v1/jobs/:id/upload", uploadDocumentation, async (context) => {
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
  routes.get("/v1/jobs/:id", statusDocumentation, async (context) => {
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
  routes.post("/v1/jobs/:id/cancel", cancellationDocumentation, async (context) => {
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

function jobCreationDocumentation<S extends Schema.Top>(
  operationId: string,
  summary: string,
  schema: S,
  ...additionalProblems: ReadonlyArray<ProblemDescriptor>
) {
  return describeRoute({
    operationId,
    parameters: [
      headerParameter(
        "idempotency-key",
        "Optional retry key. Reusing it with different input returns a conflict.",
      ),
    ],
    requestBody: jsonRequest(schema),
    responses: {
      "201": successResponse(
        "The job was created and is awaiting upload.",
        JobCreatedResponseSchema,
      ),
      ...problemResponses(
        invalidRequestProblemDescriptor,
        ...additionalProblems,
        authRequiredProblemDescriptor,
        billingUserProblemDescriptor,
        creditsExhaustedProblemDescriptor,
        idempotencyConflictProblemDescriptor,
        requestTooLargeProblemDescriptor,
        uploadLimitProblemDescriptor,
        internalErrorProblemDescriptor,
      ),
    },
    security: bearerSecurity,
    summary,
    tags: ["Media jobs"],
  });
}
