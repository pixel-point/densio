import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ExecutionPlanExecuteRequestSchema,
  JobActionSchema,
  ExecutionPlanExecuteResponseSchema,
  JobEventPageSchema,
  JobExecutionReceiptSchema,
  JobListQuerySchema,
  JobListResponseSchema,
  JobLookupQuerySchema,
  JobProgressSchema,
  JobReceiptBillingSchema,
  JobStatusSchema,
} from "../src/index.ts";

import { receipt, timestamp } from "./job-fixtures.ts";

const progress = {
  activeOutputs: [
    {
      codec: "vp9",
      etaSeconds: { maximum: 12, minimum: 8 },
      filename: "preview-vp9-35.webm",
      index: 1,
      processedDurationSeconds: 2.5,
      total: 2,
      totalDurationSeconds: 3,
      variantId: "vp9-35",
    },
    {
      codec: "av1",
      filename: "preview-av1-40.webm",
      index: 2,
      processedDurationSeconds: 1.5,
      total: 2,
      totalDurationSeconds: 3,
      variantId: "av1-40",
    },
  ],
  attempt: 2,
  percent: 61,
  phase: "encoding",
  revision: 7,
};

const base = {
  organizationId: "org-1",
  createdByUserId: "user-1",
  actions: [
    {
      kind: "wait",
      method: "GET",
      url: "https://api.densio.test/v1/organizations/org-1/jobs/job-1",
    },
    {
      kind: "cancel",
      method: "POST",
      url: "https://api.densio.test/v1/organizations/org-1/jobs/job-1/cancel",
    },
  ],
  clientReference: "homepage-hero/2026-08-14",
  createdAt: timestamp,
  id: "job-1",
  idempotencyKey: "encode-homepage-hero",
  plan: "pro",
  progress,
  sourceId: "source-1",
  executionPlanId: "plan-1",
  state: "processing",
  updatedAt: timestamp,
  workflow: "compress",
};

describe("job request recovery keys", () => {
  it("accepts a printable root client reference", () => {
    const request = {
      clientReference: "homepage-hero/2026-08-14",
    };

    expect(Schema.decodeUnknownSync(ExecutionPlanExecuteRequestSchema)(request)).toEqual(request);
  });

  it("rejects control characters and references longer than 200 characters", () => {
    const decode = Schema.decodeUnknownSync(ExecutionPlanExecuteRequestSchema);

    expect(() => decode({ clientReference: "homepage\nhero" })).toThrow();
    expect(() => decode({ clientReference: "a".repeat(201) })).toThrow();
  });
});

describe("job creation replay", () => {
  it("lets a replay report the current non-uploadable state without an upload action", () => {
    const replay = {
      organizationId: "org-1",
      jobId: "job-1",
      replayed: true,
      state: "processing",
      statusUrl: "https://api.densio.test/v1/organizations/org-1/jobs/job-1",
    };

    expect(Schema.decodeUnknownSync(ExecutionPlanExecuteResponseSchema)(replay)).toEqual(replay);
  });
});

describe("structured progress and status", () => {
  it("represents concurrent active outputs with a per-job revision", () => {
    expect(Schema.decodeUnknownSync(JobProgressSchema)(progress)).toEqual(progress);
  });

  it("keeps progress revision independent from the global event sequence", () => {
    const page = {
      organizationId: "org-1",
      events: [
        {
          attempt: 2,
          jobId: "job-1",
          kind: "progress",
          occurredAt: timestamp,
          progress,
          sequence: 42,
          state: "processing",
        },
      ],
      nextCursor: 42,
    };

    expect(Schema.decodeUnknownSync(JobEventPageSchema)(page)).toEqual(page);
  });

  it.each([
    ["failed", "failed"],
    ["canceled", "canceled"],
  ] as const)(
    "requires the %s terminal phase when structured progress is present",
    (state, phase) => {
      const terminal = {
        ...base,
        receipt,
        actions: [],
        progress: { attempt: 2, percent: 61, phase, revision: 8 },
        ...(state === "failed"
          ? {
              problem: {
                code: "MEDIA_PROCESS_FAILED",
                correlationId: "request-1",
                detail: "Encoding failed.",
                jobId: "job-1",
                retryable: false,
                schemaVersion: 1,
                status: 422,
                suggestedAction: "Inspect the input.",
                title: "Media processing failed",
                type: "https://densio.test/problems/media-process-failed",
              },
            }
          : {}),
        state,
      };
      const decode = Schema.decodeUnknownSync(JobStatusSchema);

      expect(decode(terminal)).toMatchObject({ progress: { percent: 61, phase }, state });
      expect(() =>
        decode({ ...terminal, progress: { ...terminal.progress, phase: "complete" } }),
      ).toThrow();
    },
  );
});

describe("job discovery contracts", () => {
  it("binds every advertised action to its legal HTTP method", () => {
    const decode = Schema.decodeUnknownSync(JobActionSchema);

    expect(
      decode({ kind: "cancel", method: "POST", url: "https://api.densio.test/cancel" }),
    ).toEqual({ kind: "cancel", method: "POST", url: "https://api.densio.test/cancel" });
    expect(() =>
      decode({ kind: "cancel", method: "GET", url: "https://api.densio.test/cancel" }),
    ).toThrow();
  });

  it("decodes filters, summaries, actions, and opaque list cursors", () => {
    const query = {
      clientReference: "homepage-hero/2026-08-14",
      cursor: "eyJjcmVhdGVkQXQiOiIyMDI2LTA4LTE0In0",
      limit: 25,
      since: timestamp,
      state: "processing",
      workflow: "compress",
    };
    const response = {
      organizationId: "org-1",
      jobs: [base],
      nextCursor: "eyJjcmVhdGVkQXQiOiIyMDI2LTA4LTEzIn0",
    };

    expect(Schema.decodeUnknownSync(JobListQuerySchema)(query)).toEqual(query);
    expect(Schema.decodeUnknownSync(JobListResponseSchema)(response)).toEqual(response);
  });

  it("requires exactly one lookup correlation key", () => {
    const decode = Schema.decodeUnknownSync(JobLookupQuerySchema);

    expect(decode({ clientReference: "homepage-hero/2026-08-14" })).toEqual({
      clientReference: "homepage-hero/2026-08-14",
    });
    expect(decode({ idempotencyKey: "encode-homepage-hero" })).toEqual({
      idempotencyKey: "encode-homepage-hero",
    });
    expect(() => decode({})).toThrow();
    expect(() =>
      decode({
        clientReference: "homepage-hero/2026-08-14",
        idempotencyKey: "encode-homepage-hero",
      }),
    ).toThrow();
  });
});

describe("execution receipt", () => {
  it("compares exact hundredths without rejecting ordinary decimal floating-point values", () => {
    expect(
      Schema.decodeUnknownSync(JobReceiptBillingSchema)({
        actualCreditUnits: 29,
        actualCredits: 0.29,
      }),
    ).toEqual({ actualCreditUnits: 29, actualCredits: 0.29 });
  });

  it("requires source, intent, execution, billing, and artifact facts", () => {
    const decode = Schema.decodeUnknownSync(JobExecutionReceiptSchema);

    expect(decode(receipt)).toEqual(receipt);
    for (const field of ["source", "intent", "execution", "billing", "artifacts"] as const) {
      const { [field]: _, ...incomplete } = receipt;
      expect(() => decode(incomplete), field).toThrow();
    }
  });
});
