import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  ArtifactDescriptorSchema,
  ArtifactDeletedResponseSchema,
  BillingStatusSchema,
  ExecutionPlanExecuteResponseSchema,
  JobEventPageSchema,
  JobListResponseSchema,
  JobStatusSchema,
  PreparedSourceListResponseSchema,
} from "../src/index.ts";
import { artifactDescriptor, succeededJob, timestamp } from "./job-fixtures.ts";

describe("organization-owned media contracts", () => {
  it("requires organization identity even on empty pages and mutation receipts", () => {
    const cases = [
      [JobListResponseSchema, { jobs: [] }],
      [PreparedSourceListResponseSchema, { sources: [] }],
      [JobEventPageSchema, { events: [], nextCursor: 0 }],
      [
        ArtifactDeletedResponseSchema,
        { artifactId: "artifact-1", deleted: true, deletedAt: timestamp },
      ],
      [
        ExecutionPlanExecuteResponseSchema,
        {
          replayed: false,
          jobId: "job-1",
          state: "queued",
          statusUrl: "https://api.densio.sh/v1/organizations/org-1/jobs/job-1",
        },
      ],
    ] as const;
    for (const [schema, value] of cases) {
      expect(Schema.is<unknown>(schema)(value)).toBe(false);
      expect(Schema.is<unknown>(schema)({ ...value, organizationId: "org-1" })).toBe(true);
    }
  });

  it("requires organization and initiating actor on jobs, and organization on artifacts", () => {
    const job = { ...succeededJob };
    Reflect.deleteProperty(job, "organizationId");
    expect(Schema.is(JobStatusSchema)(job)).toBe(false);
    const descriptor = { ...artifactDescriptor };
    Reflect.deleteProperty(descriptor, "organizationId");
    expect(Schema.is(ArtifactDescriptorSchema)(descriptor)).toBe(false);
  });

  it("reports one organization's shared allowance and separate billing contact", () => {
    const status = {
      organizationId: "org-1",
      billingEmail: "finance@example.test",
      plan: "basic",
      entitlementSource: "stripe",
      credits: { available: 749, monthly: 750, used: 1, reserved: 0, resetsAt: timestamp },
    };
    expect(Schema.decodeUnknownSync(BillingStatusSchema)(status)).toEqual(status);
    expect(Schema.is(BillingStatusSchema)({ ...status, organizationId: undefined })).toBe(false);
  });
});
