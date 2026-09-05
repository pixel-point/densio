import { trimTimelineDescriptor } from "./problems/execution-plan-problems.ts";
import {
  JobCreateRequestSchema,
  ExecutionPlanExecuteResponseSchema,
  JobIdempotencyKeySchema,
  successEnvelope,
} from "@densio/shared";
import { videoStorageProblemDescriptors } from "./problems/video-storage-problems.ts";
import { Effect, Schema } from "effect";
import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import type { ExecutionPlanRouteDependencies } from "./execution-plans.ts";
import {
  beginRequest,
  decodeRequestJson,
  invalidRequestProblem,
  requireHeader,
  runRouteEffect,
  successEnvelopeInput,
} from "./route-support.ts";
import {
  organizationPathParameter,
  organizationReadErrors,
  organizationRouteActor,
} from "./organization-route-support.ts";
import {
  bearerSecurity,
  headerParameter,
  jsonRequest,
  problemResponses,
  successResponse,
} from "./openapi-support.ts";
import {
  internalErrorProblemDescriptor,
  invalidRequestProblemDescriptor,
  requestTooLargeProblemDescriptor,
} from "../errors/problem-details.ts";
import { authRequiredProblemDescriptor } from "./problems/auth-problems.ts";
import { organizationProblemDescriptor } from "./problems/organization-problems.ts";
import {
  hlsSourceUnsupportedDescriptor,
  executionPlanClientReferenceDescriptor,
  executionPlanCreditsDescriptor,
  executionPlanEntitlementDescriptor,
  executionPlanGuardDescriptor,
  executionPlanIdempotencyDescriptor,
  executionPlanInvalidDescriptor,
  executionPlanOutputDescriptor,
  executionPlanSourceDescriptor,
  mediaDecisionRequiredDescriptor,
} from "./problems/execution-plan-problems.ts";

const decodeEnvelope = Schema.decodeUnknownSync(
  successEnvelope(ExecutionPlanExecuteResponseSchema),
);

export const registerJobSubmission = (
  routes: Hono,
  dependencies: ExecutionPlanRouteDependencies,
) => {
  routes.post("/v1/organizations/:organizationId/jobs", documentation, async (context) => {
    const correlationId = beginRequest(context, dependencies.createCorrelationId);
    const now = dependencies.now();
    const program = Effect.gen(function* () {
      const request = yield* decodeRequestJson(context.req.raw, JobCreateRequestSchema);
      const identity = yield* organizationRouteActor(context, dependencies, "media-write");
      const idempotencyKey = yield* requireHeader(context.req.header("idempotency-key")).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(JobIdempotencyKeySchema)),
        Effect.mapError(() => invalidRequestProblem()),
      );
      const billing = yield* dependencies.billingService.getEntitlement({
        now,
        priceIds: dependencies.priceIds,
        organizationId: identity.organizationId,
      });
      return yield* dependencies.executionPlanService.submit({
        ...identity,
        request,
        idempotencyKey,
        now,
        availableCredits: billing.credits.available,
        entitlements: billing.entitlements,
      });
    });
    return runRouteEffect(context, correlationId, program, (created) =>
      context.json(
        decodeEnvelope(successEnvelopeInput(created, correlationId)),
        created.replayed ? 200 : 201,
      ),
    );
  });
};

const documentation = describeRoute({
  operationId: "createJob",
  summary: "Submit a media job",
  tags: ["Media jobs"],
  security: bearerSecurity,
  description: [
    "Resolve a ready source and start work directly. Standalone trim requires options.trim and options.output.codec; compression accepts the same optional range. Start is inclusive, end exclusive, frames are zero-based source positions, and omitted end means video EOF. Exact trims re-encode and quote only the resolved clip duration. The API validates options and entitlements, resolves shared defaults, freezes an exact execution snapshot, and atomically reserves credits with job creation. Public execution plans are optional previews. A required idempotency key replays the same accepted job after source expiry; changing the original intent conflicts. MEDIA_DECISION_REQUIRED includes choices in details and does not admit a job. constraints.maxCredits rejects excessive quotes before spending; maxOutputBytes limits publication after encoding, which is still charged when the output exceeds the limit. Read the snapshot using the job's executionPlanId. Job success and durable storage readiness are separate states.",
    "Compression and quality comparison accept options.bitDepth (8 or 10, default 8), including compression with trim options. The comparison reference and all preview videos use that depth. 10-bit outputs are verified before publication; OUTPUT_BIT_DEPTH_MISMATCH fails the job without publishing artifacts. Keep comparison and final compression at the same depth. HLS retains its separate Main10 SDR profile.",
  ].join("\n\n"),
  parameters: [
    organizationPathParameter,
    headerParameter(
      "idempotency-key",
      "Required retry key bound to the original submission intent.",
      true,
      JobIdempotencyKeySchema,
    ),
  ],
  requestBody: jsonRequest(JobCreateRequestSchema, {
    trim: {
      summary: "Create one frame-accurate clip",
      value: {
        sourceId: "source-id",
        workflow: "trim",
        options: {
          trim: { start: { kind: "frame", frame: 30 }, end: { kind: "frame", frame: 60 } },
          output: { codec: "h265" },
        },
      },
    },
    trimCompression: {
      summary: "Trim before compression",
      value: {
        sourceId: "source-id",
        workflow: "compress",
        options: {
          trim: { start: { kind: "frame", frame: 30 }, end: { kind: "frame", frame: 60 } },
        },
      },
    },
    hls: {
      summary: "Create HEVC HLS with shared CRF defaults",
      value: {
        sourceId: "source-id",
        workflow: "hls",
        storage: { destination: { kind: "managed" }, visibility: "public" },
      },
    },
    compress: {
      summary: "Compress using shared defaults",
      value: { sourceId: "source-id", workflow: "compress" },
    },
    extraction: {
      summary: "Extract images",
      value: { sourceId: "source-id", workflow: "extract-images", options: { intervalSeconds: 5 } },
    },
    comparison: {
      summary: "Compare CRFs",
      value: {
        sourceId: "source-id",
        workflow: "compare-quality",
        options: {
          variants: [
            { codec: "h265", crf: 28 },
            { codec: "h265", crf: 30 },
          ],
        },
      },
    },
  }),
  responses: {
    "200": successResponse("The accepted job was replayed.", ExecutionPlanExecuteResponseSchema),
    "201": successResponse(
      "The job and exact credit reservation were created.",
      ExecutionPlanExecuteResponseSchema,
    ),
    ...problemResponses(
      trimTimelineDescriptor,
      invalidRequestProblemDescriptor,
      authRequiredProblemDescriptor,
      ...organizationReadErrors.map(organizationProblemDescriptor),
      executionPlanSourceDescriptor,
      hlsSourceUnsupportedDescriptor,
      ...videoStorageProblemDescriptors,
      executionPlanIdempotencyDescriptor,
      executionPlanClientReferenceDescriptor,
      executionPlanCreditsDescriptor,
      executionPlanEntitlementDescriptor,
      executionPlanGuardDescriptor,
      executionPlanInvalidDescriptor,
      executionPlanOutputDescriptor,
      mediaDecisionRequiredDescriptor,
      requestTooLargeProblemDescriptor,
      internalErrorProblemDescriptor,
    ),
  },
});
