import { runAdminStorageCommand } from "./admin-storage-command.ts";
import type { StorageRecoveryDependencies } from "../storage/recovery/storage-recovery.ts";
import {
  grantAdminPro,
  listAdminProGrants,
  revokeAdminPro,
  findBillingAccount,
} from "../billing/billing-repository.ts";
import type { Database } from "../database/database.ts";
import type { StripeGateway } from "../billing/stripe-gateway.ts";
import { runAdminBillingCommand } from "./admin-billing-command.ts";

interface AdminCommandDependencies {
  readonly grantedBy: string;
  readonly now: () => number;
  readonly storage?: StorageRecoveryDependencies;
  readonly gateway?: StripeGateway["Service"];
}

export const runAdminCommand = async (
  database: Database,
  arguments_: ReadonlyArray<string>,
  dependencies: AdminCommandDependencies,
) => {
  if (arguments_[0] === "storage")
    return runAdminStorageCommand(database, arguments_, dependencies);
  if (arguments_[0] === "billing")
    return runAdminBillingCommand(database, arguments_, dependencies);
  if (arguments_[0] !== "pro") return invalidUsage();
  if (arguments_[1] === "list" && arguments_.length === 2) {
    return { exitCode: 0 as const, output: { grants: listAdminProGrants(database) } };
  }
  if ((arguments_[1] !== "grant" && arguments_[1] !== "revoke") || arguments_.length !== 3) {
    return invalidUsage();
  }

  const organizationId = arguments_[2];
  if (organizationId === undefined || organizationId.trim() === "") return invalidUsage();
  if (findBillingAccount(database, organizationId) === undefined) return organizationMissing();

  if (arguments_[1] === "grant") {
    const outcome = grantAdminPro(database, {
      grantedBy: dependencies.grantedBy,
      now: dependencies.now(),
      organizationId,
    });
    if (outcome.kind === "organization-missing") return organizationMissing();
    return {
      exitCode: 0 as const,
      output: { created: outcome.created, organizationId },
    };
  }

  const revoked = revokeAdminPro(database, {
    now: dependencies.now(),
    organizationId,
    revokedBy: dependencies.grantedBy,
  });
  return { exitCode: 0 as const, output: { organizationId, revoked } };
};

const invalidUsage = () => ({
  error: {
    code: "INVALID_USAGE",
    message:
      "Usage: api-admin pro grant <organization-id> | revoke <organization-id> | list; api-admin billing inspect <organization-id> | reconcile <organization-id>; api-admin storage inspect <organization-id> | reconcile <organization-id> <object-id>",
  },
  exitCode: 2 as const,
});

const organizationMissing = () => ({
  error: { code: "ORGANIZATION_NOT_FOUND", message: "The organization does not exist." },
  exitCode: 4 as const,
});
