import { readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { and, asc, eq, exists, gt, inArray, isNotNull, isNull, notExists, sql } from "drizzle-orm";
import { Clock, Effect, Schema } from "effect";

import type { Database } from "../database/database.ts";
import {
  artifactAccessGrants,
  artifacts,
  jobs,
  jobWriteActivities,
  organizations,
} from "../database/schema.ts";
import { runMaintenancePages } from "../services/maintenance-pages.ts";
import { reapStoppedJobWriters } from "./job-write-activity.ts";
import {
  cleanupJobWorkspace,
  type JobStoragePaths,
  makeJobStoragePaths,
} from "../storage/workspace.ts";

export class TerminalWorkspaceCleanupError extends Schema.TaggedErrorClass<TerminalWorkspaceCleanupError>()(
  "TerminalWorkspaceCleanupError",
  { cause: Schema.Defect() },
) {}

export const cleanupTerminalJobWorkspaces = Effect.fn("TerminalWorkspaceCleanup.run")(function* (
  database: Database,
  mediaRoot: string,
) {
  yield* reapStoppedJobWriters(database);
  return yield* runMaintenancePages(
    ({ afterId, limit }) =>
      tryTerminalCleanup(() =>
        database.db
          .select({ id: jobs.id })
          .from(jobs)
          .where(
            and(
              pendingJobCleanup(database),
              afterId === undefined ? undefined : gt(jobs.id, afterId),
            ),
          )
          .orderBy(asc(jobs.id))
          .limit(limit)
          .all(),
      ),
    (job) => cleanupTerminalJob(database, mediaRoot, job.id),
    "Job workspace cleanup",
  );
});

const cleanupTerminalJobArtifacts = Effect.fn("TerminalWorkspaceCleanup.artifacts")(function* (
  database: Database,
  paths: JobStoragePaths,
  job: Pick<typeof jobs.$inferSelect, "id" | "state">,
) {
  if (job.state === "succeeded") {
    return yield* cleanupUnusedArtifactAttempts(database, paths, job.id);
  }
  if (!isUnsuccessfulTerminal(job.state)) return;
  const now = yield* Clock.currentTimeMillis;
  yield* tombstoneTerminalJobArtifacts(database, job.id, now);
  yield* removeArtifactDirectory(paths.artifactDirectory);
  yield* deleteTombstonedJobArtifacts(database, job.id);
});

const cleanupUnusedArtifactAttempts = Effect.fn("TerminalWorkspaceCleanup.unusedAttempts")(
  function* (database: Database, paths: JobStoragePaths, jobId: string) {
    const retainedDirectories = yield* tryTerminalCleanup(
      () =>
        new Set(
          database.db
            .select({ path: artifacts.path })
            .from(artifacts)
            .where(eq(artifacts.jobId, jobId))
            .all()
            .map(({ path }) => dirname(path)),
        ),
    );
    const entries = yield* Effect.tryPromise({
      try: () =>
        readdir(paths.artifactDirectory, { withFileTypes: true }).catch((cause: unknown) => {
          if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
          throw cause;
        }),
      catch: (cause) => new TerminalWorkspaceCleanupError({ cause }),
    });
    yield* Effect.forEach(
      entries.filter(
        (entry) =>
          /^attempt-[1-9][0-9]*$/.test(entry.name) &&
          !retainedDirectories.has(join(paths.artifactDirectory, entry.name)),
      ),
      (entry) => removeArtifactDirectory(join(paths.artifactDirectory, entry.name)),
    );
  },
);

export const cleanupTerminalJob = Effect.fn("TerminalWorkspaceCleanup.job")(function* (
  database: Database,
  mediaRoot: string,
  jobId: string,
) {
  const context = yield* tryTerminalCleanup(() =>
    database.db
      .select({ job: jobs, organizationState: organizations.state })
      .from(jobs)
      .innerJoin(organizations, eq(organizations.id, jobs.organizationId))
      .where(and(eq(jobs.id, jobId), pendingJobCleanup(database)))
      .get(),
  );
  if (context === undefined) return;
  const { job, organizationState } = context;
  const paths = yield* makeJobStoragePaths(mediaRoot, job.id);
  if (organizationState === "active") yield* cleanupTerminalJobArtifacts(database, paths, job);
  if (organizationState !== "active") {
    const pending = yield* tryTerminalCleanup(() =>
      database.db
        .select({ id: artifacts.id })
        .from(artifacts)
        .where(and(eq(artifacts.jobId, jobId), isNotNull(artifacts.deletionError)))
        .get(),
    );
    if (pending !== undefined)
      return yield* new TerminalWorkspaceCleanupError({
        cause: new Error("Artifact cleanup remains pending."),
      });
    yield* removeArtifactDirectory(paths.artifactDirectory);
  }
  yield* cleanupJobWorkspace(paths);
  const now = yield* Clock.currentTimeMillis;
  yield* tryTerminalCleanup(() =>
    database.db
      .update(jobs)
      .set({ workspaceCleanedAt: now })
      .where(
        and(
          eq(jobs.id, jobId),
          pendingJobCleanup(database),
          exists(
            database.db
              .select()
              .from(organizations)
              .where(
                and(
                  eq(organizations.id, job.organizationId),
                  eq(organizations.state, organizationState),
                ),
              ),
          ),
        ),
      )
      .run(),
  );
});

const pendingJobCleanup = (database: Database) =>
  and(
    inArray(jobs.state, ["succeeded", "failed", "canceled"]),
    isNull(jobs.workspaceCleanedAt),
    notExists(
      database.db.select().from(jobWriteActivities).where(eq(jobWriteActivities.jobId, jobs.id)),
    ),
  );

const tombstoneTerminalJobArtifacts = Effect.fn("TerminalWorkspaceCleanup.tombstoneArtifacts")(
  function* (database: Database, jobId: string, now: number) {
    yield* tryTerminalCleanup(() =>
      database.db.transaction(
        (transaction) => {
          const artifactIds = transaction
            .select({ id: artifacts.id })
            .from(artifacts)
            .where(eq(artifacts.jobId, jobId))
            .all()
            .map(({ id }) => id);
          transaction
            .update(artifacts)
            .set({
              deletedAt: sql`coalesce(${artifacts.deletedAt}, ${now})`,
              deletionError: null,
            })
            .where(eq(artifacts.jobId, jobId))
            .run();
          if (artifactIds.length === 0) return;
          transaction
            .delete(artifactAccessGrants)
            .where(inArray(artifactAccessGrants.artifactId, artifactIds))
            .run();
        },
        { behavior: "immediate" },
      ),
    );
  },
);

const deleteTombstonedJobArtifacts = (database: Database, jobId: string) =>
  tryTerminalCleanup(() =>
    database.db
      .delete(artifacts)
      .where(and(eq(artifacts.jobId, jobId), isNotNull(artifacts.deletedAt)))
      .run(),
  );

const removeArtifactDirectory = (directory: string) =>
  Effect.tryPromise({
    catch: (cause) => new TerminalWorkspaceCleanupError({ cause }),
    try: () => rm(directory, { force: true, recursive: true }),
  });

const tryTerminalCleanup = <Value>(evaluate: () => Value) =>
  Effect.try({
    catch: (cause) => new TerminalWorkspaceCleanupError({ cause }),
    try: evaluate,
  });

const isUnsuccessfulTerminal = (state: typeof jobs.$inferSelect.state) =>
  state === "failed" || state === "canceled";
