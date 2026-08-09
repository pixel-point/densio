import { Schema } from "effect";

import type { Plan } from "./common-contracts.ts";

export const PAID_PLANS = ["basic", "pro", "premium"] as const;
export const PaidPlanSchema = Schema.Literals(PAID_PLANS);
export type PaidPlan = typeof PaidPlanSchema.Type;

export const PLAN_CATALOG = Object.freeze({
  basic: Object.freeze({
    maxUploadBytes: 10_000_000_000,
    monthlyCredits: 750,
    queuePriority: 10,
    rank: 1,
  }),
  free: Object.freeze({
    maxUploadBytes: 1_000_000_000,
    monthlyCredits: 30,
    queuePriority: 0,
    rank: 0,
  }),
  premium: Object.freeze({
    maxUploadBytes: 10_000_000_000,
    monthlyCredits: 7_500,
    queuePriority: 30,
    rank: 3,
  }),
  pro: Object.freeze({
    maxUploadBytes: 10_000_000_000,
    monthlyCredits: 5_000,
    queuePriority: 20,
    rank: 2,
  }),
} satisfies Record<
  Plan,
  {
    readonly maxUploadBytes: number;
    readonly monthlyCredits: number;
    readonly queuePriority: number;
    readonly rank: number;
  }
>);
