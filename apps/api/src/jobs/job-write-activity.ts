import { randomUUID } from "node:crypto";
import { asc, eq, gt } from "drizzle-orm";
import { Effect } from "effect";
import type { Database } from "../database/database.ts";
import { jobs, jobWriteActivities } from "../database/schema.ts";
import { organizationStorage } from "../organizations/organization-service.ts";
import { runMaintenancePages } from "../services/maintenance-pages.ts";
import { writerIsAlive, writerProcessIdentity } from "../services/writer-process.ts";
import { isTerminalJob } from "./job-transition.ts";
import { ProcessWriteActivity } from "../services/process-write-activity.ts";

// A lease fences database writes, but does not stop delayed filesystem I/O.
// Keep durable writer evidence until all native I/O and child processes unwind.
export const withJobWriteActivity = <A, E, R>(
  database: Database,
  job: typeof jobs.$inferSelect,
  program: Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    organizationStorage("begin-job-write", () =>
      database.db.transaction(
        (transaction) => {
          const current = transaction.select().from(jobs).where(eq(jobs.id, job.id)).get();
          if (
            current === undefined ||
            isTerminalJob(current.state) ||
            (job.state === "preparing"
              ? current.state !== "preparing"
              : current.leaseOwner !== job.leaseOwner || current.attemptCount !== job.attemptCount)
          )
            return undefined;
          return transaction
            .insert(jobWriteActivities)
            .values({
              id: randomUUID(),
              jobId: job.id,
              processId: process.pid,
              processIdentity: writerProcessIdentity(process.pid),
              createdAt: Date.now(),
            })
            .returning()
            .get();
        },
        { behavior: "immediate" },
      ),
    ).pipe(Effect.orDie),
    (activity) =>
      activity === undefined
        ? Effect.succeed(undefined)
        : program.pipe(
            Effect.provideService(ProcessWriteActivity, {
              track: (processId) => {
                const child = database.db
                  .insert(jobWriteActivities)
                  .values({
                    id: randomUUID(),
                    jobId: job.id,
                    processId,
                    processIdentity: writerProcessIdentity(processId),
                    createdAt: Date.now(),
                  })
                  .returning()
                  .get();
                return () => {
                  database.db
                    .delete(jobWriteActivities)
                    .where(eq(jobWriteActivities.id, child.id))
                    .run();
                };
              },
            }),
          ),
    (activity) =>
      Effect.sync(() => {
        if (activity !== undefined)
          database.db
            .delete(jobWriteActivities)
            .where(eq(jobWriteActivities.id, activity.id))
            .run();
      }),
  );

export const reapStoppedJobWriters = (database: Database) =>
  runMaintenancePages(
    ({ afterId, limit }) =>
      organizationStorage("list-job-writers", () =>
        database.db
          .select()
          .from(jobWriteActivities)
          .where(afterId === undefined ? undefined : gt(jobWriteActivities.id, afterId))
          .orderBy(asc(jobWriteActivities.id))
          .limit(limit)
          .all(),
      ),
    (activity) =>
      organizationStorage("reap-job-writer", () => {
        if (!writerIsAlive(activity.processId, activity.processIdentity))
          database.db
            .delete(jobWriteActivities)
            .where(eq(jobWriteActivities.id, activity.id))
            .run();
      }),
    "Stopped job writer recovery",
  );
