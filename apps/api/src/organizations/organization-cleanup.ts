import { storageClosurePending } from "../storage/storage-closure.ts";
import { and, asc, count, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { Effect } from "effect";
import type { Database } from "../database/database.ts";
import { artifacts, jobs, organizations, preparedSources } from "../database/schema.ts";
import { appendOrganizationAudit } from "../database/organization-audit-repository.ts";
import { cleanupExpiredArtifacts } from "../database/artifact-repository.ts";
import { cleanupPreparedSources } from "../sources/source-cleanup.ts";
import { cleanupTerminalJobWorkspaces } from "../jobs/terminal-workspace-cleanup.ts";
import { runMaintenancePages } from "../services/maintenance-pages.ts";
import { organizationStorage } from "./organization-service.ts";

// Resource owners perform deletion. Organization closure only observes their
// durable completion markers; it has no independent filesystem cleanup engine.
export const maintainOrganizationDeletions = Effect.fn("Organization.maintainDeletions")(function* (
  database: Database,
  mediaRoot: string,
  now: number,
) {
  yield* cleanupPreparedSources(database, mediaRoot, now);
  yield* cleanupExpiredArtifacts(database, { mediaRoot, now });
  yield* cleanupTerminalJobWorkspaces(database, mediaRoot);
  return yield* runMaintenancePages(
    ({ afterId, limit }) =>
      organizationStorage("list-deleting-organizations", () =>
        database.db
          .select()
          .from(organizations)
          .where(
            and(
              eq(organizations.state, "deleting"),
              afterId === undefined ? undefined : gt(organizations.id, afterId),
            ),
          )
          .orderBy(asc(organizations.id))
          .limit(limit)
          .all(),
      ),
    (organization) =>
      organizationStorage("finish-organization-cleanup", () =>
        finishCleanup(database, organization.id, now),
      ),
    "Organization deletion",
  );
});

const finishCleanup = (database: Database, organizationId: string, now: number) =>
  database.db.transaction(
    (transaction) => {
      const pending = [
        transaction
          .select({ count: count() })
          .from(artifacts)
          .where(
            and(eq(artifacts.organizationId, organizationId), isNotNull(artifacts.deletionError)),
          )
          .get()?.count ?? 0,
        transaction
          .select({ count: count() })
          .from(preparedSources)
          .where(
            and(
              eq(preparedSources.organizationId, organizationId),
              isNull(preparedSources.cleanedAt),
            ),
          )
          .get()?.count ?? 0,
        transaction
          .select({ count: count() })
          .from(jobs)
          .where(and(eq(jobs.organizationId, organizationId), isNull(jobs.workspaceCleanedAt)))
          .get()?.count ?? 0,
      ].some((value) => value > 0);
      if (pending || storageClosurePending(transaction, organizationId)) {
        transaction
          .update(organizations)
          .set({ cleanupError: "pending-resource-cleanup" })
          .where(eq(organizations.id, organizationId))
          .run();
        return;
      }
      const completed = transaction
        .update(organizations)
        .set({ state: "deleted", deletedAt: now, updatedAt: now, cleanupError: null })
        .where(and(eq(organizations.id, organizationId), eq(organizations.state, "deleting")))
        .returning()
        .get();
      if (completed !== undefined)
        appendOrganizationAudit(transaction, {
          organizationId,
          kind: "organization-deleted",
          actor: { kind: "system", service: "organization-cleanup" },
          targetId: organizationId,
          now,
          correlationId: `cleanup-${organizationId}`,
        });
    },
    { behavior: "immediate" },
  );
