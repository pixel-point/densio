import { Effect } from "effect";
import type { Database } from "../database/database.ts";
import { inspectBillingRecovery, reconcileBillingRecovery } from "../billing/billing-recovery.ts";
import type { StripeGateway } from "../billing/stripe-gateway.ts";
import { OrganizationError } from "../organizations/organization-errors.ts";
import { organizationStorage } from "../organizations/organization-service.ts";

export const runAdminBillingCommand = async (
  database: Database,
  args: readonly string[],
  dependencies: {
    grantedBy: string;
    now: () => number;
    gateway?: StripeGateway["Service"];
  },
) => {
  const organizationId = args[2];
  if (
    args.length !== 3 ||
    organizationId === undefined ||
    organizationId.trim() === "" ||
    (args[1] !== "inspect" && args[1] !== "reconcile")
  )
    return {
      exitCode: 2 as const,
      error: {
        code: "INVALID_USAGE",
        message: "Usage: api-admin billing inspect <organization-id> | reconcile <organization-id>",
      },
    };
  if (args[1] === "reconcile" && dependencies.gateway === undefined)
    return {
      exitCode: 2 as const,
      error: {
        code: "BILLING_NOT_CONFIGURED",
        message: "Configure the Stripe gateway before reconciliation.",
      },
    };
  const operation = Effect.gen(function* () {
    if (args[1] === "inspect" || dependencies.gateway === undefined)
      return yield* organizationStorage("inspect-billing-recovery", () =>
        inspectBillingRecovery(database, organizationId),
      );
    return yield* reconcileBillingRecovery(database, dependencies.gateway, {
      organizationId,
      operator: dependencies.grantedBy,
      now: dependencies.now(),
    });
  });
  return Effect.runPromise(
    operation.pipe(
      Effect.match({
        onSuccess: (output) => ({ exitCode: 0 as const, output }),
        onFailure: (error) => ({
          exitCode: 4 as const,
          error: {
            code: error instanceof OrganizationError ? error.code : "BILLING_RECONCILIATION_FAILED",
            message:
              error instanceof OrganizationError
                ? error.detail
                : "Provider reconciliation failed. Retry this command; the operation remains pending.",
          },
        }),
      }),
    ),
  );
};
