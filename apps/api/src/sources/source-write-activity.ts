import { randomUUID } from "node:crypto";
import { and, asc, eq, gt } from "drizzle-orm";
import { Effect } from "effect";
import type { Database } from "../database/database.ts";
import { organizations, preparedSources, sourceWriteActivities } from "../database/schema.ts";
import { organizationStorage } from "../organizations/organization-service.ts";
import { organizationFailure } from "../organizations/organization-errors.ts";
import { runMaintenancePages } from "../services/maintenance-pages.ts";
import { writerIsAlive, writerProcessIdentity } from "../services/writer-process.ts";

// SQLite and its media directory live on one host. Never expire a live writer by
// elapsed time: a stalled/paused process can still resume a filesystem write.
export const withSourceWriteActivity = <A, E, R>(
  database: Database,
  source: { id: string; organizationId: string },
  program: Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    organizationStorage("begin-source-write", () =>
      database.db.transaction(
        (transaction) => {
          const organization = transaction
            .select()
            .from(organizations)
            .where(eq(organizations.id, source.organizationId))
            .get();
          const current = transaction
            .select()
            .from(preparedSources)
            .where(eq(preparedSources.id, source.id))
            .get();
          if (
            organization?.state !== "active" ||
            current === undefined ||
            current.organizationId !== source.organizationId ||
            current.state === "failed" ||
            current?.state === "deleted" ||
            current?.state === "expired"
          )
            throw organizationFailure(
              "ORGANIZATION_NOT_ACTIVE",
              "This source no longer accepts writes.",
            );
          return transaction
            .insert(sourceWriteActivities)
            .values({
              id: randomUUID(),
              sourceId: source.id,
              organizationId: source.organizationId,
              processId: process.pid,
              processIdentity: writerProcessIdentity(process.pid),
              createdAt: Date.now(),
            })
            .returning()
            .get();
        },
        { behavior: "immediate" },
      ),
    ),
    () => program,
    (activity) =>
      organizationStorage("finish-source-write", () =>
        database.db
          .delete(sourceWriteActivities)
          .where(eq(sourceWriteActivities.id, activity.id))
          .run(),
      ).pipe(Effect.orDie),
  );

export const reapStoppedSourceWriters = (database: Database) =>
  runMaintenancePages(
    ({ afterId, limit }) =>
      organizationStorage("list-source-writers", () =>
        database.db
          .select()
          .from(sourceWriteActivities)
          .where(afterId === undefined ? undefined : gt(sourceWriteActivities.id, afterId))
          .orderBy(asc(sourceWriteActivities.id))
          .limit(limit)
          .all(),
      ),
    (activity) =>
      organizationStorage("reap-source-writer", () => {
        if (writerIsAlive(activity.processId, activity.processIdentity)) return;
        database.db
          .delete(sourceWriteActivities)
          .where(
            and(
              eq(sourceWriteActivities.id, activity.id),
              eq(sourceWriteActivities.processId, activity.processId),
            ),
          )
          .run();
      }),
    "Stopped upload writer recovery",
  );
