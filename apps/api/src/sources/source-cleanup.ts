import { and, eq, inArray, isNull, notExists } from "drizzle-orm";
import { Effect } from "effect";
import type { Database } from "../database/database.ts";
import {
  listSourceCleanupCandidates,
  markSourceCleaned,
} from "../database/prepared-source-repository.ts";
import { preparedSources, sourceWriteActivities } from "../database/schema.ts";
import { organizationStorage } from "../organizations/organization-service.ts";
import { runMaintenancePages } from "../services/maintenance-pages.ts";
import { cleanupSourceWorkspace, makeSourceStoragePaths } from "../storage/source-workspace.ts";
import { reapStoppedSourceWriters } from "./source-write-activity.ts";

export const cleanupPreparedSource = Effect.fn("Source.cleanup")(function* (
  database: Database,
  mediaRoot: string,
  sourceId: string,
  now: number,
) {
  const pending = yield* organizationStorage("source-cleanup-pending", () =>
    database.db
      .select({ id: preparedSources.id })
      .from(preparedSources)
      .where(
        and(
          eq(preparedSources.id, sourceId),
          isNull(preparedSources.cleanedAt),
          inArray(preparedSources.state, ["expired", "deleted", "failed"]),
          notExists(
            database.db
              .select()
              .from(sourceWriteActivities)
              .where(eq(sourceWriteActivities.sourceId, preparedSources.id)),
          ),
        ),
      )
      .get(),
  );
  if (pending === undefined) return;
  yield* makeSourceStoragePaths(mediaRoot, sourceId).pipe(Effect.flatMap(cleanupSourceWorkspace));
  yield* organizationStorage("mark-source-cleaned", () =>
    markSourceCleaned(database, sourceId, now),
  );
});

export const cleanupPreparedSources = Effect.fn("Source.cleanupPending")(function* (
  database: Database,
  mediaRoot: string,
  now: number,
) {
  yield* reapStoppedSourceWriters(database);
  return yield* runMaintenancePages(
    ({ afterId, limit }) =>
      organizationStorage("pending-source-cleanup", () =>
        listSourceCleanupCandidates(database, limit, afterId),
      ),
    (source) => cleanupPreparedSource(database, mediaRoot, source.id, now),
    "Source cleanup",
  );
});
