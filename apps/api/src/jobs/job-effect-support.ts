import { Effect } from "effect";

import { JobRepositoryError } from "./job-errors.ts";
import { OrganizationError } from "../organizations/organization-errors.ts";
import {
  ExecutionPlanSourceUnavailable,
  ExecutionPlanEntitlementRejected,
} from "../execution-plans/execution-plan-errors.ts";

export const tryJobRepository = Effect.fn("JobRepository.evaluate")(
  <Value>(operation: string, evaluate: () => Value) =>
    Effect.try({
      catch: (cause) =>
        cause instanceof OrganizationError ||
        cause instanceof ExecutionPlanSourceUnavailable ||
        cause instanceof ExecutionPlanEntitlementRejected
          ? cause
          : new JobRepositoryError({ cause, operation }),
      try: evaluate,
    }),
);
