import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  AuthPollResponseSchema,
  AuthStartResponseSchema,
  AuthStatusSchema,
  BillingSessionResponseSchema,
  BillingStatusSchema,
  CheckoutPlanRequestSchema,
  ProblemDetailsSchema,
  successEnvelope,
} from "../src/index.ts";

describe("authentication responses", () => {
  it("accepts a magic-link challenge without a redundant short code", () => {
    const response = {
      challengeId: "challenge-1",
      pollToken: "poll-secret",
      expiresAt: "2026-07-11T12:10:00.000Z",
      pollAfterSeconds: 2,
    };

    expect(Schema.decodeUnknownSync(AuthStartResponseSchema)(response)).toEqual(response);
  });

  it("models pending and confirmed polling responses", () => {
    const decode = Schema.decodeUnknownSync(AuthPollResponseSchema);
    const pending = {
      status: "pending",
      expiresAt: "2026-07-11T12:10:00.000Z",
      pollAfterSeconds: 2,
    };
    const confirmed = {
      status: "confirmed",
      accessToken: "access-secret",
      accessTokenExpiresAt: "2026-07-11T12:15:00.000Z",
      refreshToken: "refresh-secret",
    };

    expect(decode(pending)).toEqual(pending);
    expect(decode(confirmed)).toEqual(confirmed);
  });

  it("distinguishes anonymous and authenticated status", () => {
    const decode = Schema.decodeUnknownSync(AuthStatusSchema);

    expect(decode({ authenticated: false })).toEqual({ authenticated: false });
    expect(
      decode({
        authenticated: true,
        user: { id: "user-1", email: "person@example.test", plan: "pro" },
        sessionExpiresAt: "2026-08-11T12:00:00.000Z",
      }),
    ).toMatchObject({ authenticated: true });
  });
});

describe("billing responses", () => {
  it.each(["checkout", "portal"])("accepts a signed %s URL", (kind) => {
    const response = {
      kind,
      url: "https://billing.example.test/session/123",
      expiresAt: "2026-07-11T12:10:00.000Z",
    };

    expect(Schema.decodeUnknownSync(BillingSessionResponseSchema)(response)).toEqual(response);
  });

  it("reports independent Stripe and administrator entitlements", () => {
    const status = {
      credits: {
        available: 4_998.7,
        monthly: 5_000,
        reserved: 0.05,
        resetsAt: "2026-09-01T00:00:00.000Z",
        used: 1.25,
      },
      plan: "pro",
      entitlementSource: "both",
      subscriptionStatus: "past_due",
      renewsAt: "2026-08-11T12:00:00.000Z",
    };

    expect(Schema.decodeUnknownSync(BillingStatusSchema)(status)).toEqual(status);
  });

  it("accepts only paid plans for Checkout", () => {
    const decode = Schema.decodeUnknownSync(CheckoutPlanRequestSchema);

    expect(decode({ plan: "basic" })).toEqual({ plan: "basic" });
    expect(decode({ plan: "premium" })).toEqual({ plan: "premium" });
    expect(() => decode({ plan: "free" })).toThrow();
  });
});

describe("transport envelopes", () => {
  it("wraps successful data in a versioned machine-readable envelope", () => {
    const schema = successEnvelope(Schema.Struct({ value: Schema.String }));
    const response = {
      ok: true,
      schemaVersion: 1,
      data: { value: "ready" },
      correlationId: "request-1",
    };

    expect(Schema.decodeUnknownSync(schema)(response)).toEqual(response);
    expect(() => Schema.decodeUnknownSync(schema)({ ...response, schemaVersion: 2 })).toThrow();
  });

  it("accepts RFC 9457 problem details with stable recovery metadata", () => {
    const problem = {
      type: "https://ffmpeg-api.example/problems/credits-exhausted",
      title: "Credits exhausted",
      status: 402,
      detail: "All 30 monthly credits are used or reserved.",
      instance: "/v1/jobs/job-1",
      schemaVersion: 1,
      code: "CREDITS_EXHAUSTED",
      retryable: false,
      suggestedAction: "Wait for the monthly reset or upgrade the account plan.",
      correlationId: "request-1",
      jobId: "job-1",
    };

    expect(Schema.decodeUnknownSync(ProblemDetailsSchema)(problem)).toEqual(problem);
  });

  it("rejects unstable error codes and invalid HTTP statuses", () => {
    const base = {
      type: "about:blank",
      title: "Invalid input",
      status: 400,
      detail: "The request was invalid.",
      schemaVersion: 1,
      code: "VALIDATION_FAILED",
      retryable: false,
      suggestedAction: "Correct the request and try again.",
      correlationId: "request-1",
    };
    const decode = Schema.decodeUnknownSync(ProblemDetailsSchema);

    expect(() => decode({ ...base, code: "validation-failed" })).toThrow();
    expect(() => decode({ ...base, status: 200 })).toThrow();
  });
});
