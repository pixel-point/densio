import { storagePurgeCandidates } from "../storage/managed/storage-purge-candidates.ts";
import {
  PLAN_CATALOG,
  StorageDestinationSchema,
  type StoredDestination,
  type StorageUsage,
  type StorageVisibility,
  StorageConnectionConfigSchema,
} from "@densio/shared";
import { eq, sql } from "drizzle-orm";
import { Schema } from "effect";
import { findEffectiveBillingEntitlement } from "../billing/billing-repository.ts";
import type { Database } from "../database/database.ts";
import { storageObjects, storageSettings, videos } from "../database/video-storage-schema.ts";
import { storageFailure } from "../storage/storage-errors.ts";
import { requireActiveConnection } from "../storage/connections/connection-catalog.ts";
import type { VideoServiceConfig } from "./video-config.ts";

export const storageUsage = (
  database: Database,
  config: VideoServiceConfig,
  organizationId: string,
): StorageUsage => {
  const billing = findEffectiveBillingEntitlement(database, {
    organizationId,
    now: config.now(),
    priceIds: config.priceIds,
  });
  if (billing === undefined) throw storageFailure("VIDEO_NOT_FOUND");
  const totals = database.db
    .select({
      used: sql<number>`coalesce(sum(case when ${videos.capacityState} = 'used' then ${videos.totalBytes} else 0 end), 0)`,
      reserved: sql<number>`coalesce(sum(case when ${videos.capacityState} = 'reserved' then ${videos.totalBytes} else 0 end), 0)`,
    })
    .from(videos)
    .where(eq(videos.organizationId, organizationId))
    .get();
  const physical = database.db
    .select({
      transient: sql<number>`coalesce(sum(case when ${storageObjects.bucketRole} = 'staging' and ${storageObjects.state} != 'deleted' then ${storageObjects.bytes} else 0 end), 0)`,
      cleanup: sql<number>`coalesce(sum(case when ${storageObjects.state} = 'deleting' then ${storageObjects.bytes} else 0 end), 0)`,
    })
    .from(storageObjects)
    .where(eq(storageObjects.organizationId, organizationId))
    .get();
  const limit = PLAN_CATALOG[billing.entitlements.plan].includedStorageBytes;
  const settings = database.db
    .select()
    .from(storageSettings)
    .where(eq(storageSettings.organizationId, organizationId))
    .get();
  return {
    organizationId,
    plan: billing.entitlements.plan,
    includedStorageBytes: limit,
    usedBytes: totals?.used ?? 0,
    reservedBytes: totals?.reserved ?? 0,
    transientBytes: physical?.transient ?? 0,
    cleanupPendingBytes: physical?.cleanup ?? 0,
    availableBytes: Math.max(0, limit - (totals?.used ?? 0) - (totals?.reserved ?? 0)),
    ...(settings?.graceDeadline == null
      ? {}
      : { graceDeadline: new Date(settings.graceDeadline).toISOString() }),
    purgeVideoIds:
      settings?.graceDeadline == null
        ? []
        : storagePurgeCandidates(database, organizationId, limit),
  };
};

export const storageDefaults = (database: Database, organizationId: string) => {
  const row = database.db
    .select()
    .from(storageSettings)
    .where(eq(storageSettings.organizationId, organizationId))
    .get();
  return {
    destination: Schema.decodeUnknownSync(Schema.fromJsonString(StorageDestinationSchema))(
      row?.destinationJson ?? '{"kind":"temporary"}',
    ),
    visibility: row?.visibility ?? ("public" as const),
  };
};

export const validateDestination = (
  database: Database,
  config: VideoServiceConfig,
  organizationId: string,
  destination: StoredDestination,
  visibility: StorageVisibility,
) => {
  if (destination.kind === "managed") {
    const usage = storageUsage(database, config, organizationId);
    if (usage.includedStorageBytes === 0)
      throw storageFailure("STORAGE_UPGRADE_REQUIRED", "Densio storage requires a paid plan.");
    if (!config.managedTargetId || !config.managedPublicOrigin)
      throw storageFailure("STORAGE_NOT_CONFIGURED");
    if (usage.availableBytes <= 0) throw storageFailure("STORAGE_QUOTA_EXCEEDED");
    return {
      targetId: config.managedTargetId,
      publicOrigin: config.managedPublicOrigin,
      prefix: "",
      connectionId: null,
    };
  }
  const row = requireActiveConnection(database, organizationId, destination.connectionId);
  const connection = Schema.decodeUnknownSync(Schema.fromJsonString(StorageConnectionConfigSchema))(
    row.configJson,
  );
  if (connection.visibility !== visibility) throw storageFailure("STORAGE_VISIBILITY_UNSUPPORTED");
  if (visibility === "public" && !connection.publicBaseUrl)
    throw storageFailure("STORAGE_PUBLIC_DELIVERY_REQUIRED");
  return {
    targetId: `connection:${row.id}`,
    publicOrigin: connection.publicBaseUrl ?? null,
    prefix: [connection.location.prefix, "densio", organizationId, row.id, "videos"]
      .filter(Boolean)
      .join("/"),
    connectionId: row.id,
  };
};
