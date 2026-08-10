import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { PAID_PLANS, PLAN_CATALOG, PLAN_NAMES, PaidPlanSchema, PlanSchema } from "../src/index.ts";

describe("plan catalog", () => {
  it("defines the four monthly credit plans", () => {
    expect(PLAN_NAMES).toEqual(["free", "basic", "pro", "scale"]);
    expect(PLAN_CATALOG).toEqual({
      basic: {
        maxUploadBytes: 10_000_000_000,
        maxVideoDurationSeconds: 10_800,
        monthlyCredits: 750,
        queuePriority: 10,
        rank: 1,
      },
      free: {
        maxUploadBytes: 1_000_000_000,
        maxVideoDurationSeconds: 1_800,
        monthlyCredits: 30,
        queuePriority: 0,
        rank: 0,
      },
      scale: {
        maxUploadBytes: 10_000_000_000,
        maxVideoDurationSeconds: 10_800,
        monthlyCredits: 7_500,
        queuePriority: 30,
        rank: 3,
      },
      pro: {
        maxUploadBytes: 10_000_000_000,
        maxVideoDurationSeconds: 10_800,
        monthlyCredits: 5_000,
        queuePriority: 20,
        rank: 2,
      },
    });
  });

  it("keeps paid checkout plans separate from Free", () => {
    const decodePlan = Schema.decodeUnknownSync(PlanSchema);
    const decodePaidPlan = Schema.decodeUnknownSync(PaidPlanSchema);

    expect(PLAN_NAMES.map((plan) => decodePlan(plan))).toEqual(PLAN_NAMES);
    expect(PAID_PLANS.map((plan) => decodePaidPlan(plan))).toEqual(["basic", "pro", "scale"]);
    expect(() => decodePaidPlan("free")).toThrow();
  });
});
