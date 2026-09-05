import { eq } from "drizzle-orm";
import { storageConnections } from "../database/video-storage-schema.ts";
import { openConnectionStores } from "./connections/connection-store.ts";
import { makeCloudflarePurger } from "./managed/cloudflare-cdn.ts";
import type { StorageTarget } from "./objects/object-store.ts";
import { makeS3ObjectStore } from "./objects/s3-object-store.ts";
import { storageFailure } from "./storage-errors.ts";
import type { Database } from "../database/database.ts";
import type { AppConfig } from "../config.ts";
import { managedTargetId } from "./storage-config.ts";
import type { ConnectionProviderConfig } from "./connections/connection-store.ts";
export const makeStorageTargets = (
  database: Database,
  config: AppConfig,
  connectionsConfig: ConnectionProviderConfig,
) => {
  const resolveTarget = async (id: string, role: StorageTarget["role"]): Promise<StorageTarget> => {
    const managed = config.storage.managedTargets.find((target) => managedTargetId(target) === id);
    if (managed)
      return {
        id,
        role,
        store: makeS3ObjectStore(
          {
            endpoint: managed.endpoint,
            region: "auto",
            bucket:
              role === "public"
                ? managed.publicBucket
                : role === "private"
                  ? managed.privateBucket
                  : managed.stagingBucket,
            prefix: "",
            pathStyle: true,
          },
          managed.credentials,
        ),
        ...(role === "public" ? { publicOrigin: managed.publicOrigin } : {}),
      };
    const row = id.startsWith("connection:")
      ? database.db
          .select()
          .from(storageConnections)
          .where(eq(storageConnections.id, id.slice(11)))
          .get()
      : undefined;
    if (!row || row.state === "disconnected")
      throw storageFailure("STORAGE_CONNECTION_UNAVAILABLE");
    const stores = openConnectionStores(row, connectionsConfig);
    if (role === "staging" && !stores.staging) {
      stores.output.close();
      throw storageFailure("STORAGE_PRIVATE_STAGING_REQUIRED");
    }
    const store = role === "staging" ? stores.staging! : stores.output;
    if (role === "staging") stores.output.close();
    if (role !== "staging") stores.staging?.close();
    return {
      id,
      role,
      store,
      ...(role === "public" && stores.definition.publicBaseUrl
        ? { publicOrigin: stores.definition.publicBaseUrl }
        : {}),
    };
  };
  const purge = async (urls: readonly string[], signal?: AbortSignal) => {
    for (const target of config.storage.managedTargets) {
      const owned = urls.filter(
        (url) => new URL(url).origin === new URL(target.publicOrigin).origin,
      );
      if (owned.length) await makeCloudflarePurger(target.zoneId, target.purgeToken)(owned, signal);
    }
    if (
      urls.some(
        (url) =>
          !config.storage.managedTargets.some(
            (target) => new URL(url).origin === new URL(target.publicOrigin).origin,
          ),
      )
    )
      throw storageFailure("STORAGE_NOT_CONFIGURED");
  };
  return { resolveTarget, purge };
};
