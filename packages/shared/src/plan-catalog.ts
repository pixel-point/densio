import { Schema } from "effect";

import type { Plan } from "./common-contracts.ts";

export const PAID_PLANS = ["basic", "pro", "scale"] as const;
export const PaidPlanSchema = Schema.Literals(PAID_PLANS);
export type PaidPlan = typeof PaidPlanSchema.Type;

export const PLAN_CATALOG = Object.freeze({
  basic: Object.freeze({
    includedStorageBytes: 25_000_000_000,
    customerStorage: true,
    maxUploadBytes: 10_000_000_000,
    maxVideoDurationSeconds: 10_800,
    monthlyCredits: 750,
    queuePriority: 10,
    rank: 1,
  }),
  free: Object.freeze({
    includedStorageBytes: 0,
    customerStorage: true,
    maxUploadBytes: 1_000_000_000,
    maxVideoDurationSeconds: 1_800,
    monthlyCredits: 30,
    queuePriority: 0,
    rank: 0,
  }),
  scale: Object.freeze({
    includedStorageBytes: 500_000_000_000,
    customerStorage: true,
    maxUploadBytes: 10_000_000_000,
    maxVideoDurationSeconds: 10_800,
    monthlyCredits: 7_500,
    queuePriority: 30,
    rank: 3,
  }),
  pro: Object.freeze({
    includedStorageBytes: 100_000_000_000,
    customerStorage: true,
    maxUploadBytes: 10_000_000_000,
    maxVideoDurationSeconds: 10_800,
    monthlyCredits: 5_000,
    queuePriority: 20,
    rank: 2,
  }),
} satisfies Record<
  Plan,
  {
    readonly includedStorageBytes: number;
    readonly customerStorage: boolean;
    readonly maxUploadBytes: number;
    readonly maxVideoDurationSeconds: number;
    readonly monthlyCredits: number;
    readonly queuePriority: number;
    readonly rank: number;
  }
>);
