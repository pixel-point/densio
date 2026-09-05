import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database, DatabaseTransaction } from "../../database/database.ts";
import {
  storageObjects,
  videoVariants,
  videoPackageMembers,
} from "../../database/video-storage-schema.ts";
import { managedObjectKey } from "../managed/object-key.ts";

export type StorageFile =
  | (typeof videoVariants.$inferSelect & { readonly kind: "variant" })
  | (typeof videoPackageMembers.$inferSelect & { readonly kind: "hls" });

export const videoStorageFiles = (
  transaction: Database["db"] | DatabaseTransaction,
  videoId: string,
): ReadonlyArray<StorageFile> => [
  ...transaction
    .select()
    .from(videoVariants)
    .where(eq(videoVariants.videoId, videoId))
    .all()
    .map((file) => ({ ...file, kind: "variant" as const })),
  ...transaction
    .select()
    .from(videoPackageMembers)
    .where(eq(videoPackageMembers.videoId, videoId))
    .all()
    .map((file) => ({ ...file, kind: "hls" as const }))
    .toSorted((left, right) => publicationOrder(left.role) - publicationOrder(right.role)),
];

export const fileObjectPredicate = (file: StorageFile) =>
  file.kind === "hls"
    ? eq(storageObjects.packageMemberId, file.id)
    : eq(storageObjects.variantId, file.id);

export const activateStorageFile = (
  transaction: Database["db"] | DatabaseTransaction,
  file: StorageFile,
  objectId: string,
) => {
  const table = file.kind === "hls" ? videoPackageMembers : videoVariants;
  transaction.update(table).set({ activeObjectId: objectId }).where(eq(table.id, file.id)).run();
};

export const privateFileKey = (file: StorageFile) =>
  file.kind === "hls"
    ? `orgs/${file.organizationId}/videos/${file.videoId}/private/${randomUUID()}/${file.filename}`
    : managedObjectKey(file.organizationId, file.videoId, file.filename, randomUUID());

const publicationOrder = (role: typeof videoPackageMembers.$inferSelect.role) =>
  role === "master" ? 2 : role === "playlist" ? 1 : 0;
