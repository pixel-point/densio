import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../../database/database.ts";
import {
  storageTransfers,
  videoVariants,
  videoPackageMembers,
} from "../../database/video-storage-schema.ts";
import { transferNeedsInput } from "./object-consumers.ts";

export const artifactHasStorageReader = (database: Database, artifactId: string) =>
  [videoVariants, videoPackageMembers].some((table) =>
    database.db
      .select({ transfer: storageTransfers })
      .from(storageTransfers)
      .innerJoin(table, eq(table.videoId, storageTransfers.videoId))
      .where(
        and(
          eq(table.artifactId, artifactId),
          inArray(storageTransfers.state, [
            "pending",
            "uploading",
            "verifying",
            "retry-wait",
            "blocked",
          ]),
        ),
      )
      .all()
      .some(({ transfer }) => transferNeedsInput(transfer, Date.now())),
  );
