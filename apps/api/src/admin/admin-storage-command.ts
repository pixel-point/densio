import type { Database } from "../database/database.ts";
import {
  inspectUncertainUploads,
  reconcileUncertainUpload,
  type StorageRecoveryDependencies,
} from "../storage/recovery/storage-recovery.ts";

export const runAdminStorageCommand = async (
  database: Database,
  args: readonly string[],
  dependencies: {
    readonly grantedBy: string;
    readonly now: () => number;
    readonly storage?: StorageRecoveryDependencies;
  },
) => {
  const [, command, organizationId, objectId] = args;
  if (
    !organizationId ||
    (command !== "inspect" && command !== "reconcile") ||
    args.length !== (command === "inspect" ? 3 : 4) ||
    (command === "reconcile" && !objectId)
  )
    return {
      exitCode: 2 as const,
      error: {
        code: "INVALID_USAGE",
        message:
          "Usage: api-admin storage inspect ORGANIZATION_ID | reconcile ORGANIZATION_ID OBJECT_ID",
      },
    };
  const evidence = {
    organizationId,
    operator: dependencies.grantedBy,
    observedAt: new Date(dependencies.now()).toISOString(),
  };
  if (command === "inspect")
    return {
      exitCode: 0 as const,
      output: { ...evidence, objects: inspectUncertainUploads(database, organizationId) },
    };
  if (!dependencies.storage)
    return {
      exitCode: 2 as const,
      error: {
        code: "STORAGE_NOT_CONFIGURED",
        message: "Storage recovery requires configured provider access.",
      },
    };
  const result = await reconcileUncertainUpload(
    database,
    organizationId,
    objectId!,
    dependencies.storage,
  );
  return {
    exitCode:
      result.outcome === "adopted" || result.outcome === "not-uncertain"
        ? (0 as const)
        : (4 as const),
    output: { ...evidence, ...result },
  };
};
