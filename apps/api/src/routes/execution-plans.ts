import { trimTimelineDescriptor } from "./problems/execution-plan-problems.ts";
import {
  ExecutionPlanCreateRequestSchema,
  ExecutionPlanCreateResponseSchema,
  ExecutionPlanExecuteRequestSchema,
  ExecutionPlanExecuteResponseSchema,
  ExecutionPlanResolveRequestSchema,
  ExecutionPlanResolveResponseSchema,
  ExecutionPlanStatusSchema,
  JobIdempotencyKeySchema,
  successEnvelope,
} from "@densio/shared";
import { videoStorageProblemDescriptors } from "./problems/video-storage-problems.ts";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { registerJobSubmission } from "./job-submission.ts";

import type { AuthService } from "../auth/auth-service.ts";
import type { OrganizationService } from "../organizations/organization-service.ts";
import {
  organizationRouteActor,
  organizationPathParameter,
  organizationReadErrors,
} from "./organization-route-support.ts";
import { organizationProblemDescriptor } from "./problems/organization-problems.ts";
import type { BillingService } from "../billing/billing-service.ts";
import type { BillingPriceIds } from "../billing/billing-repository.ts";
import {
  internalErrorProblemDescriptor,
  invalidRequestProblemDescriptor,
  requestTooLargeProblemDescriptor,
} from "../errors/problem-details.ts";
import type { makeExecutionPlanService } from "../execution-plans/execution-plan-service.ts";
import {
  beginRequest,
  decodeRequestJson,
  invalidRequestProblem,
  requireHeader,
  runRouteEffect,
  successEnvelopeInput,
} from "./route-support.ts";
import {
  bearerSecurity,
  headerParameter,
  jsonRequest,
  pathParameter,
  problemResponses,
  successResponse,
} from "./openapi-support.ts";
import { authRequiredProblemDescriptor } from "./problems/auth-problems.ts";
import {
  hlsSourceUnsupportedDescriptor,
  executionPlanClientReferenceDescriptor,
  executionPlanCreditsDescriptor,
  executionPlanDecisionRequiredDescriptor,
  executionPlanEntitlementDescriptor,
  executionPlanExpiredDescriptor,
  executionPlanGuardDescriptor,
  executionPlanIdempotencyDescriptor,
  executionPlanInvalidDescriptor,
  executionPlanNotFoundDescriptor,
  executionPlanOutputDescriptor,
  executionPlanSourceDescriptor,
  executionPlanStateDescriptor,
} from "./problems/execution-plan-problems.ts";

const decodeCreateEnvelope = Schema.decodeUnknownSync(
  successEnvelope(ExecutionPlanCreateResponseSchema),
);
const decodeStatusEnvelope = Schema.decodeUnknownSync(successEnvelope(ExecutionPlanStatusSchema));
const decodeResolveEnvelope = Schema.decodeUnknownSync(
  successEnvelope(ExecutionPlanResolveResponseSchema),
);
const decodeExecuteEnvelope = Schema.decodeUnknownSync(
  successEnvelope(ExecutionPlanExecuteResponseSchema),
);

export interface ExecutionPlanRouteDependencies {
  readonly organizationService: OrganizationService;
  readonly authService: AuthService["Service"];
  readonly billingService: BillingService["Service"];
  readonly createCorrelationId: () => string;
  readonly executionPlanService: ReturnType<typeof makeExecutionPlanService>;
  readonly now: () => number;
  readonly priceIds: BillingPriceIds;
}

export const createExecutionPlanRoutes = (dependencies: ExecutionPlanRouteDependencies) => {
  const routes = new Hono();
  routes.post(
    "/v1/organizations/:organizationId/execution-plans",
    createDocumentation,
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const now = dependencies.now();
      const program = Effect.gen(function* () {
        const request = yield* decodeRequestJson(context.req.raw, ExecutionPlanCreateRequestSchema);
        const identity = yield* organizationRouteActor(context, dependencies, "media-read");
        const idempotencyKey = yield* optionalIdempotencyKey(context.req.raw);
        const billing = yield* entitlement(dependencies, identity.organizationId, now);
        return yield* dependencies.executionPlanService.create({
          availableCredits: billing.credits.available,
          entitlements: billing.entitlements,
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          now,
          request,
          ...identity,
        });
      });
      return runRouteEffect(context, correlationId, program, (created) =>
        context.json(
          decodeCreateEnvelope(successEnvelopeInput(created, correlationId)),
          created.replayed ? 200 : 201,
        ),
      );
    },
  );
  routes.get(
    "/v1/organizations/:organizationId/execution-plans/:id",
    statusDocumentation,
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const now = dependencies.now();
      const program = Effect.gen(function* () {
        const identity = yield* organizationRouteActor(context, dependencies, "media-read");
        return yield* dependencies.executionPlanService.get({
          now,
          planId: context.req.param("id"),
          ...identity,
        });
      });
      return runRouteEffect(context, correlationId, program, (status) =>
        context.json(decodeStatusEnvelope(successEnvelopeInput(status, correlationId))),
      );
    },
  );
  registerResolve(routes, dependencies);
  registerExecute(routes, dependencies);
  registerJobSubmission(routes, dependencies);
  return routes;
};

const registerResolve = (routes: Hono, dependencies: ExecutionPlanRouteDependencies) => {
  routes.post(
    "/v1/organizations/:organizationId/execution-plans/:id/resolve",
    resolveDocumentation,
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const now = dependencies.now();
      const program = Effect.gen(function* () {
        const request = yield* decodeRequestJson(
          context.req.raw,
          ExecutionPlanResolveRequestSchema,
        );
        const identity = yield* organizationRouteActor(context, dependencies, "media-read");
        const idempotencyKey = yield* optionalIdempotencyKey(context.req.raw);
        const billing = yield* entitlement(dependencies, identity.organizationId, now);
        return yield* dependencies.executionPlanService.resolve({
          availableCredits: billing.credits.available,
          entitlements: billing.entitlements,
          frameRate: request.frameRate,
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          now,
          planId: context.req.param("id"),
          ...identity,
        });
      });
      return runRouteEffect(context, correlationId, program, (resolved) =>
        context.json(
          decodeResolveEnvelope(successEnvelopeInput(resolved, correlationId)),
          resolved.replayed ? 200 : 201,
        ),
      );
    },
  );
};

const registerExecute = (routes: Hono, dependencies: ExecutionPlanRouteDependencies) => {
  routes.post(
    "/v1/organizations/:organizationId/execution-plans/:id/execute",
    executeDocumentation,
    async (context) => {
      const correlationId = beginRequest(context, dependencies.createCorrelationId);
      const now = dependencies.now();
      const program = Effect.gen(function* () {
        const request = yield* decodeRequestJson(
          context.req.raw,
          ExecutionPlanExecuteRequestSchema,
        );
        const identity = yield* organizationRouteActor(context, dependencies, "media-read");
        const idempotencyKey = yield* requireIdempotencyKey(context.req.raw);
        const billing = yield* entitlement(dependencies, identity.organizationId, now);
        return yield* dependencies.executionPlanService.execute({
          availableCredits: billing.credits.available,
          entitlements: billing.entitlements,
          idempotencyKey,
          now,
          planId: context.req.param("id"),
          ...identity,
          ...(request.clientReference === undefined
            ? {}
            : { clientReference: request.clientReference }),
          ...(request.maxCredits === undefined ? {} : { maxCredits: request.maxCredits }),
          ...(request.maxOutputBytes === undefined
            ? {}
            : { maxOutputBytes: request.maxOutputBytes }),
        });
      });
      return runRouteEffect(context, correlationId, program, (executed) =>
        context.json(
          decodeExecuteEnvelope(successEnvelopeInput(executed, correlationId)),
          executed.replayed ? 200 : 201,
        ),
      );
    },
  );
};

const entitlement = (
  dependencies: ExecutionPlanRouteDependencies,
  organizationId: string,
  now: number,
) =>
  dependencies.billingService.getEntitlement({
    now,
    priceIds: dependencies.priceIds,
    organizationId,
  });

const requireIdempotencyKey = Effect.fn("ExecutionPlanRoutes.idempotencyKey")((request: Request) =>
  requireHeader(request.headers.get("idempotency-key") ?? undefined).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(JobIdempotencyKeySchema)),
    Effect.mapError(() => invalidRequestProblem()),
  ),
);

const optionalIdempotencyKey = Effect.fn("ExecutionPlanRoutes.optionalIdempotencyKey")(function* (
  request: Request,
) {
  const value = request.headers.get("idempotency-key");
  if (value === null) return undefined;
  return yield* Schema.decodeUnknownEffect(JobIdempotencyKeySchema)(value).pipe(
    Effect.mapError(() => invalidRequestProblem()),
  );
});

const createProblems = problemResponses(
  trimTimelineDescriptor,
  hlsSourceUnsupportedDescriptor,
  ...videoStorageProblemDescriptors,
  invalidRequestProblemDescriptor,
  authRequiredProblemDescriptor,
  ...organizationReadErrors.map(organizationProblemDescriptor),
  executionPlanSourceDescriptor,
  executionPlanIdempotencyDescriptor,
  executionPlanGuardDescriptor,
  executionPlanEntitlementDescriptor,
  executionPlanOutputDescriptor,
  executionPlanInvalidDescriptor,
  requestTooLargeProblemDescriptor,
  internalErrorProblemDescriptor,
);

const statusProblems = problemResponses(
  authRequiredProblemDescriptor,
  ...organizationReadErrors.map(organizationProblemDescriptor),
  executionPlanNotFoundDescriptor,
  internalErrorProblemDescriptor,
);

const resolveProblems = problemResponses(
  trimTimelineDescriptor,
  hlsSourceUnsupportedDescriptor,
  ...videoStorageProblemDescriptors,
  invalidRequestProblemDescriptor,
  authRequiredProblemDescriptor,
  ...organizationReadErrors.map(organizationProblemDescriptor),
  executionPlanNotFoundDescriptor,
  executionPlanSourceDescriptor,
  executionPlanStateDescriptor,
  executionPlanExpiredDescriptor,
  executionPlanIdempotencyDescriptor,
  executionPlanGuardDescriptor,
  executionPlanEntitlementDescriptor,
  executionPlanInvalidDescriptor,
  requestTooLargeProblemDescriptor,
  internalErrorProblemDescriptor,
);

const executeProblems = problemResponses(
  invalidRequestProblemDescriptor,
  authRequiredProblemDescriptor,
  ...organizationReadErrors.map(organizationProblemDescriptor),
  executionPlanNotFoundDescriptor,
  executionPlanSourceDescriptor,
  executionPlanExpiredDescriptor,
  executionPlanDecisionRequiredDescriptor,
  executionPlanIdempotencyDescriptor,
  executionPlanGuardDescriptor,
  executionPlanCreditsDescriptor,
  executionPlanClientReferenceDescriptor,
  requestTooLargeProblemDescriptor,
  internalErrorProblemDescriptor,
);

const optionalIdempotencyParameter = headerParameter(
  "idempotency-key",
  "Optional printable retry key. Reuse is safe only for the exact same intent.",
  false,
  JobIdempotencyKeySchema,
);

const requiredIdempotencyParameter = headerParameter(
  "idempotency-key",
  "Required printable spending-operation retry key. Reuse is safe only for the exact same intent.",
  true,
  JobIdempotencyKeySchema,
);

const createDocumentation = describeRoute({
  description: [
    "Compression and quality comparison accept options.bitDepth (8 or 10, default 8). One depth applies to all outputs and the comparison reference. New ready plans freeze the resolved depth. 10-bit outputs are verified before publication; a mismatch fails the job with OUTPUT_BIT_DEPTH_MISMATCH. This option does not enable HDR processing.",
    "Trimming accepts options.trim with an inclusive start and optional exclusive end. Positions use zero-based source frames, seconds, or timecodes; omitted end selects video EOF. Standalone workflow trim requires one output codec, preserves cadence, applies existing even-dimension normalization, and re-encodes. Compression trims before transforms. Quotes use the resolved selected duration. Unsupported frame timing returns TRIM_TIMELINE_UNSUPPORTED (422).",
    "Plans compress, trim, hls, extract-images, or compare-quality against an owned ready source. Planning inspects and resolves intent but does not reserve credits or encode media. A ready plan includes the exact quote, resolved options, expected artifacts, warnings, and toolchain. Compression may return decision-required for an explicit frame-rate choice; resolve it before executing.",
    "Quality comparison uses one matrix shape: 2–8 unique codec/CRF variants and 1–5 samples. Omitted samples default to three automatic windows. Explicit positions accept seconds, timecode, or zero-based frame indexes. One sample is valid but yields low-confidence coverage. Requested durationSeconds is 1–3 (default 1), clipped near the end of the source; normalized windows are frozen in the plan.",
    "SSIM is required and enabled by default; request objectiveMetrics [ssim, psnr] to add PSNR. Perfect PSNR is represented as the string infinite. Candidates share a lossless reference reel and produce previews, stills, metrics, coverage, Pareto candidates, and a balanced recommendation. Estimated full-video sizes are video-only extrapolations, not output-size guarantees.",
    "Optional constraints.maxCredits caps the exact quote before spending; constraints.maxOutputBytes sets an aggregate post-encode publication limit. For decision-required plans, quote validation occurs when resolving the decision. Review the ready plan before execution.",
  ].join("\n\n"),
  operationId: "createExecutionPlan",
  parameters: [organizationPathParameter, optionalIdempotencyParameter],
  requestBody: jsonRequest(ExecutionPlanCreateRequestSchema, {
    trim: {
      summary: "Preview an exact frame clip",
      value: {
        sourceId: "source-id",
        workflow: "trim",
        options: {
          trim: { start: { kind: "frame", frame: 30 }, end: { kind: "frame", frame: 60 } },
          output: { codec: "h265" },
        },
      },
    },
    compress: {
      summary: "Compress an uploaded source with an explicit frame-rate policy",
      value: {
        sourceId: "source-id",
        workflow: "compress",
        options: { codecs: ["vp9"], crf: { vp9: 32 }, frameRate: { mode: "preserve" } },
      },
    },
    compress10Bit: {
      summary: "Compress to 10-bit output",
      value: {
        sourceId: "source-id",
        workflow: "compress",
        options: { bitDepth: 10, codecs: ["vp9", "h265"] },
      },
    },
    extractImages: {
      summary: "Extract a WebP image every five seconds",
      value: {
        sourceId: "source-id",
        workflow: "extract-images",
        options: { intervalSeconds: 5, format: "webp" },
      },
    },
    compareQuality: {
      summary: "Compare two codec/CRF variants across three automatic samples",
      value: {
        sourceId: "source-id",
        workflow: "compare-quality",
        options: {
          bitDepth: 10,
          variants: [
            { codec: "vp9", crf: 32 },
            { codec: "h265", crf: 28 },
          ],
          samples: { mode: "auto", count: 3 },
          durationSeconds: 1,
          objectiveMetrics: ["ssim", "psnr"],
        },
      },
    },
    singleSample: {
      summary: "Compare two CRFs at one frame position (low-confidence coverage)",
      value: {
        sourceId: "source-id",
        workflow: "compare-quality",
        options: {
          variants: [
            { codec: "vp9", crf: 28 },
            { codec: "vp9", crf: 36 },
          ],
          samples: { mode: "positions", positions: [{ kind: "frame", frame: 0 }] },
        },
      },
    },
  }),
  responses: {
    "200": successResponse(
      "An existing immutable plan was replayed.",
      ExecutionPlanCreateResponseSchema,
    ),
    "201": successResponse("A new immutable plan was created.", ExecutionPlanCreateResponseSchema),
    ...createProblems,
  },
  security: bearerSecurity,
  summary: "Create an exact execution plan",
  tags: ["Execution plans"],
});

const statusDocumentation = describeRoute({
  description:
    "Returns the immutable plan snapshot alongside current availability (available, expired, or source-unavailable). State remains ready or decision-required even when unavailable. Only available ready plans expose execute; only available decision-required plans expose resolve. Reading an expired plan remains possible and does not renew it.",
  operationId: "getExecutionPlan",
  parameters: [organizationPathParameter, pathParameter("id", "Execution-plan identifier.")],
  responses: {
    "200": successResponse(
      "The immutable plan snapshot and live availability/actions.",
      ExecutionPlanStatusSchema,
    ),
    ...statusProblems,
  },
  security: bearerSecurity,
  summary: "Get an execution plan",
  tags: ["Execution plans"],
});

const resolveDocumentation = describeRoute({
  description:
    "Resolves a frame-rate decision by creating a new immutable ready plan with supersedesPlanId pointing to the original. Choose preserve or cap at 30 fps. The original snapshot is unchanged; this does not create or modify a job and does not reserve credits. Review and execute the returned plan, not the decision-required parent. An optional idempotency key makes retries recover the same child plan.",
  operationId: "resolveExecutionPlan",
  parameters: [
    organizationPathParameter,
    pathParameter("id", "Execution-plan identifier."),
    optionalIdempotencyParameter,
  ],
  requestBody: jsonRequest(ExecutionPlanResolveRequestSchema, {
    cap: {
      summary: "Cap frame rate at 30 fps",
      value: { frameRate: { mode: "cap", maximum: 30 } },
    },
    preserve: {
      summary: "Preserve the source frame rate",
      value: { frameRate: { mode: "preserve" } },
    },
  }),
  responses: {
    "200": successResponse(
      "An existing resolved plan was replayed.",
      ExecutionPlanResolveResponseSchema,
    ),
    "201": successResponse(
      "A new superseding plan was created.",
      ExecutionPlanResolveResponseSchema,
    ),
    ...resolveProblems,
  },
  security: bearerSecurity,
  summary: "Resolve a plan decision",
  tags: ["Execution plans"],
});

const executeDocumentation = describeRoute({
  description: [
    "Executes an available ready plan with a required idempotency-key header and a JSON body (use {} when no guards are needed). It atomically reserves the exact quote and creates a preparing job while the source is attached; follow statusUrl for subsequent queued/worker states. The same key and addressed intent replay the same job, even after plan expiry. Changing the plan, guards, or clientReference for that key returns 409; never change keys just because a response was lost.",
    "maxCredits rejects an excessive quote before reservation (412); insufficient available credits return 402. maxOutputBytes caps aggregate published artifact bytes after encoding. Exceeding that cap fails the job without publishing artifacts, but completed encoding is charged. Ordinary failure or cancellation releases the reservation. Execution limits cannot relax the plan's constraints. clientReference is an optional organization-unique recovery label; an existing label assigned to another job returns 409.",
  ].join("\n\n"),
  operationId: "executeExecutionPlan",
  parameters: [
    organizationPathParameter,
    pathParameter("id", "Execution-plan identifier."),
    requiredIdempotencyParameter,
  ],
  requestBody: jsonRequest(ExecutionPlanExecuteRequestSchema, {
    execute: { summary: "Execute using the plan's constraints", value: {} },
    guarded: {
      summary: "Execute with spending/output limits and a unique recovery reference",
      value: { maxCredits: 5, maxOutputBytes: 50000000, clientReference: "homepage-video-run-001" },
    },
  }),
  responses: {
    "200": successResponse(
      "The existing idempotent job was replayed.",
      ExecutionPlanExecuteResponseSchema,
    ),
    "201": successResponse(
      "The job was created with its exact credit reservation; returns its current state after input preparation.",
      ExecutionPlanExecuteResponseSchema,
    ),
    ...executeProblems,
  },
  security: bearerSecurity,
  summary: "Execute an immutable plan",
  tags: ["Execution plans"],
});
