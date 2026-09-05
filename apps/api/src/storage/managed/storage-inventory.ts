import { randomUUID } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import { Effect } from "effect";
import type { Database } from "../../database/database.ts";
import {
  managedInventoryScans,
  managedStorageOrphans,
  storageObjects,
} from "../../database/video-storage-schema.ts";
import { publicObjectUrl } from "../../videos/video-catalog.ts";
import type { StorageTarget } from "../objects/object-store.ts";
import { storagePromise } from "../storage-errors.ts";

const day = 86_400_000;
export interface ManagedInventoryConfig {
  readonly now: () => number;
  readonly targets: readonly { id: string; roles: readonly StorageTarget["role"][] }[];
  readonly resolveTarget: (id: string, role: StorageTarget["role"]) => Promise<StorageTarget>;
  readonly purge: (urls: readonly string[], signal?: AbortSignal) => Promise<void>;
}
export const maintainManagedInventory = (database: Database, config: ManagedInventoryConfig) =>
  Effect.forEach(
    config.targets.flatMap((target) => target.roles.map((role) => ({ target, role }))),
    ({ target, role }) =>
      auditTargetRole(database, config, target.id, role).pipe(
        Effect.catch((error) =>
          Effect.logWarning(`Storage inventory for ${target.id}/${role} will retry: ${error.code}`),
        ),
      ),
    { concurrency: 1, discard: true },
  );

const auditTargetRole = (
  database: Database,
  config: ManagedInventoryConfig,
  targetId: string,
  role: StorageTarget["role"],
) =>
  storagePromise("storage-inventory", async (signal) => {
    const id = `${targetId}/${role}`;
    const scan = database.db
      .select()
      .from(managedInventoryScans)
      .where(eq(managedInventoryScans.id, id))
      .get();
    if (scan && scan.nextRunAt > config.now() && scan.cursor === null)
      return cleanupOrphans(database, config, targetId, role, signal);
    const target = await config.resolveTarget(targetId, role);
    await Promise.resolve()
      .then(async () => {
        const page = await target.store.listObjects(
          "orgs/",
          scan?.cursor ?? undefined,
          1000,
          signal,
        );
        page.objects.forEach((object) => recordInventoryObject(database, config, target, object));
        database.db
          .insert(managedInventoryScans)
          .values({
            id,
            targetId,
            bucketRole: role,
            bucket: target.store.bucket,
            cursor: page.cursor ?? null,
            startedAt: scan?.startedAt ?? config.now(),
            nextRunAt: page.cursor ? 0 : config.now() + day,
            updatedAt: config.now(),
          })
          .onConflictDoUpdate({
            target: managedInventoryScans.id,
            set: {
              bucket: target.store.bucket,
              cursor: page.cursor ?? null,
              startedAt: page.cursor ? (scan?.startedAt ?? config.now()) : null,
              nextRunAt: page.cursor ? 0 : config.now() + day,
              updatedAt: config.now(),
            },
          })
          .run();
        if (!page.cursor) await cleanupOrphans(database, config, targetId, role, signal, target);
      })
      .finally(() => target.store.close());
  });

const recordInventoryObject = (
  database: Database,
  config: ManagedInventoryConfig,
  target: StorageTarget,
  object: { key: string; bytes: number; etag: string },
) => {
  const owned = database.db
    .select({ id: storageObjects.id })
    .from(storageObjects)
    .where(
      and(
        eq(storageObjects.targetId, target.id),
        eq(storageObjects.bucket, target.store.bucket),
        eq(storageObjects.objectKey, object.key),
      ),
    )
    .get();
  const candidate = database.db
    .select()
    .from(managedStorageOrphans)
    .where(
      and(
        eq(managedStorageOrphans.targetId, target.id),
        eq(managedStorageOrphans.bucket, target.store.bucket),
        eq(managedStorageOrphans.objectKey, object.key),
      ),
    )
    .get();
  if (owned) {
    if (candidate)
      database.db
        .delete(managedStorageOrphans)
        .where(eq(managedStorageOrphans.id, candidate.id))
        .run();
    return;
  }
  const changed = candidate && (candidate.etag !== object.etag || candidate.bytes !== object.bytes);
  database.db
    .insert(managedStorageOrphans)
    .values({
      id: candidate?.id ?? randomUUID(),
      targetId: target.id,
      bucketRole: target.role,
      bucket: target.store.bucket,
      objectKey: object.key,
      bytes: object.bytes,
      etag: object.etag,
      firstSeenAt: !candidate || changed ? config.now() : candidate.firstSeenAt,
      lastSeenAt: config.now(),
    })
    .onConflictDoUpdate({
      target: [
        managedStorageOrphans.targetId,
        managedStorageOrphans.bucket,
        managedStorageOrphans.objectKey,
      ],
      set: {
        bytes: object.bytes,
        etag: object.etag,
        firstSeenAt: !candidate || changed ? config.now() : candidate.firstSeenAt,
        lastSeenAt: config.now(),
      },
    })
    .run();
};

const cleanupOrphans = async (
  database: Database,
  config: ManagedInventoryConfig,
  targetId: string,
  role: StorageTarget["role"],
  signal: AbortSignal,
  openTarget?: StorageTarget,
) => {
  const candidates = database.db
    .select()
    .from(managedStorageOrphans)
    .where(
      and(
        eq(managedStorageOrphans.targetId, targetId),
        eq(managedStorageOrphans.bucketRole, role),
        lte(managedStorageOrphans.firstSeenAt, config.now() - 2 * day),
      ),
    )
    .limit(100)
    .all();
  if (!candidates.length) return;
  const target = openTarget ?? (await config.resolveTarget(targetId, role));
  await Promise.resolve()
    .then(async () => {
      for (const candidate of candidates)
        await deleteOrphan(database, config, target, candidate, signal);
    })
    .finally(() => {
      if (!openTarget) target.store.close();
    });
};
const deleteOrphan = async (
  database: Database,
  config: ManagedInventoryConfig,
  target: StorageTarget,
  candidate: typeof managedStorageOrphans.$inferSelect,
  signal: AbortSignal,
) => {
  const owned = database.db
    .select({ id: storageObjects.id })
    .from(storageObjects)
    .where(
      and(
        eq(storageObjects.targetId, candidate.targetId),
        eq(storageObjects.bucket, candidate.bucket),
        eq(storageObjects.objectKey, candidate.objectKey),
      ),
    )
    .get();
  if (owned) {
    database.db
      .delete(managedStorageOrphans)
      .where(eq(managedStorageOrphans.id, candidate.id))
      .run();
    return;
  }
  const facts = await target.store.head(candidate.objectKey, undefined, signal);
  if (facts && (facts.etag !== candidate.etag || facts.bytes !== candidate.bytes)) {
    database.db
      .update(managedStorageOrphans)
      .set({
        etag: facts.etag,
        bytes: facts.bytes,
        firstSeenAt: config.now(),
        lastSeenAt: config.now(),
      })
      .where(eq(managedStorageOrphans.id, candidate.id))
      .run();
    return;
  }
  if (facts) await target.store.remove(candidate.objectKey, facts.versionId, signal);
  if ((await target.store.head(candidate.objectKey, facts?.versionId, signal)) !== null) return;
  if (target.role === "public" && target.publicOrigin)
    await config.purge([publicObjectUrl(target.publicOrigin, candidate.objectKey)], signal);
  database.db.delete(managedStorageOrphans).where(eq(managedStorageOrphans.id, candidate.id)).run();
};
