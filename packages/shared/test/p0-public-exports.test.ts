import { describe, expect, it } from "vitest";

import {
  ArtifactAuthorizationSchema,
  ComparisonDecisionSchema,
  CompareQualityOptionsSchema,
  ExecutionPlanStatusSchema,
  JobEventPageSchema,
  JobExecutionReceiptSchema,
  JobProgressSchema,
  PreparedSourceStatusSchema,
} from "../src/index.ts";

describe("canonical public contract exports", () => {
  it("exposes every new control-plane contract through @densio/shared", () => {
    const schemas = [
      ArtifactAuthorizationSchema,
      ComparisonDecisionSchema,
      CompareQualityOptionsSchema,
      ExecutionPlanStatusSchema,
      JobEventPageSchema,
      JobExecutionReceiptSchema,
      JobProgressSchema,
      PreparedSourceStatusSchema,
    ];

    expect(schemas).toHaveLength(8);
    schemas.forEach((schema) => expect(schema).toBeDefined());
  });
});
