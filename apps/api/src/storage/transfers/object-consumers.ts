import { and, eq } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../../database/database.ts";
import {
  storageObjects,
  storageObjectReads,
  storageTransfers,
  videoVariants,
  videoPackageMembers,
} from "../../database/video-storage-schema.ts";
import { writerIsAlive } from "../../services/writer-process.ts";
import { storageFailure } from "../storage-errors.ts";

export const transferNeedsInput = (
  transfer: typeof storageTransfers.$inferSelect,
  now: number,
  alive = writerIsAlive,
) =>
  (transfer.workerPid !== null &&
    transfer.workerIdentity !== null &&
    alive(transfer.workerPid, transfer.workerIdentity)) ||
  (["save", "export"].includes(transfer.kind) &&
    ["pending", "uploading", "verifying", "retry-wait", "blocked"].includes(transfer.state) &&
    transfer.recoveryDeadline > now);

export const objectInputTransfers = (
  transaction: Database["db"] | DatabaseTransaction,
  objectId: string,
) =>
  [videoVariants, videoPackageMembers].flatMap((table) =>
    transaction
      .select({ transfer: storageTransfers })
      .from(table)
      .innerJoin(storageTransfers, eq(storageTransfers.videoId, table.videoId))
      .where(eq(table.inputObjectId, objectId))
      .all()
      .map(({ transfer }) => transfer),
  );

export const connectionInputTransfers = (
  transaction: Database["db"] | DatabaseTransaction,
  connectionId: string,
) =>
  [videoVariants, videoPackageMembers].flatMap((table) =>
    transaction
      .select({ transfer: storageTransfers })
      .from(table)
      .innerJoin(storageObjects, eq(storageObjects.id, table.inputObjectId))
      .innerJoin(storageTransfers, eq(storageTransfers.videoId, table.videoId))
      .where(eq(storageObjects.connectionId, connectionId))
      .all()
      .map(({ transfer }) => transfer),
  );

export const objectHasConsumers = (
  transaction: Database["db"] | DatabaseTransaction,
  objectId: string,
  config: { readonly now: () => number; readonly isWriterAlive?: typeof writerIsAlive },
) => {
  const alive = config.isWriterAlive ?? writerIsAlive;
  const readers = transaction
    .select()
    .from(storageObjectReads)
    .where(eq(storageObjectReads.objectId, objectId))
    .all();
  readers
    .filter((reader) => !alive(reader.workerPid, reader.workerIdentity))
    .forEach((reader) =>
      transaction.delete(storageObjectReads).where(eq(storageObjectReads.id, reader.id)).run(),
    );
  return (
    readers.some((reader) => alive(reader.workerPid, reader.workerIdentity)) ||
    objectInputTransfers(transaction, objectId).some((transfer) =>
      transferNeedsInput(transfer, config.now(), alive),
    )
  );
};

// Move existing consumers only after the replacement contains the identical verified bytes.
export const rebindObjectInputs = (
  transaction: Database["db"] | DatabaseTransaction,
  previous: typeof storageObjects.$inferSelect,
  replacement: typeof storageObjects.$inferSelect,
) => {
  if (
    previous.organizationId !== replacement.organizationId ||
    previous.bytes !== replacement.bytes ||
    previous.sha256 !== replacement.sha256 ||
    replacement.state !== "verified"
  )
    throw storageFailure("STORAGE_OBJECT_CHANGED");
  [videoVariants, videoPackageMembers].forEach((table) =>
    transaction
      .update(table)
      .set({ inputObjectId: replacement.id })
      .where(
        and(
          eq(table.organizationId, previous.organizationId),
          eq(table.inputObjectId, previous.id),
        ),
      )
      .run(),
  );
};
