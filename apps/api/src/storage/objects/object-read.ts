import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../../database/database.ts";
import { storageObjectReads, type storageObjects } from "../../database/video-storage-schema.ts";
import { writerProcessIdentity } from "../../services/writer-process.ts";
import type { StorageTarget } from "./object-store.ts";

export const acquireObjectRead = async (
  database: Database,
  config: {
    readonly now: () => number;
    readonly writerIdentity?: string;
    readonly resolveTarget: (id: string, role: StorageTarget["role"]) => Promise<StorageTarget>;
  },
  object: typeof storageObjects.$inferSelect,
  range: string | undefined,
  signal: AbortSignal,
) => {
  const id = randomUUID();
  database.db
    .insert(storageObjectReads)
    .values({
      id,
      objectId: object.id,
      organizationId: object.organizationId,
      workerPid: process.pid,
      workerIdentity: config.writerIdentity ?? writerProcessIdentity(process.pid),
      createdAt: config.now(),
    })
    .run();
  let released = false;
  const finalizers: (() => void)[] = [
    () => {
      database.db.delete(storageObjectReads).where(eq(storageObjectReads.id, id)).run();
    },
  ];
  // Providers can finish acquiring a resource after the request has been interrupted.
  const own = (finalize: () => void) => {
    if (released) return finalize();
    finalizers.unshift(finalize);
  };
  const release = () => {
    if (released) return;
    released = true;
    signal.removeEventListener("abort", release);
    finalizers.forEach((finalize) => finalize());
  };
  signal.addEventListener("abort", release, { once: true });
  return Promise.resolve()
    .then(async () => {
      signal.throwIfAborted();
      const target = await config.resolveTarget(object.targetId, object.bucketRole);
      own(() => target.store.close());
      signal.throwIfAborted();
      const response = await target.store.read(
        object.objectKey,
        range,
        object.versionId ?? undefined,
        signal,
      );
      own(() => {
        response.body.destroy();
      });
      signal.throwIfAborted();
      return { ...response, release };
    })
    .catch((error: unknown) => {
      release();
      throw error;
    });
};
