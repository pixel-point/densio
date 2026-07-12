import { inArray } from "drizzle-orm";
import { Effect, Schema } from "effect";

import type { Database } from "../database/database.ts";
import { jobs } from "../database/schema.ts";
import { cleanupJobWorkspace, makeJobStoragePaths } from "../storage/workspace.ts";

export class TerminalWorkspaceCleanupError extends Schema.TaggedErrorClass<TerminalWorkspaceCleanupError>()(
  "TerminalWorkspaceCleanupError",
  { cause: Schema.Defect() },
) {}

export const cleanupTerminalJobWorkspaces = Effect.fn("TerminalWorkspaceCleanup.run")(function* (
  database: Database,
  mediaRoot: string,
) {
  const terminalJobs = yield* Effect.try({
    catch: (cause) => new TerminalWorkspaceCleanupError({ cause }),
    try: () =>
      database.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(inArray(jobs.state, ["succeeded", "failed", "canceled", "expired"]))
        .all(),
  });
  const outcomes = yield* Effect.forEach(terminalJobs, ({ id }) =>
    makeJobStoragePaths(mediaRoot, id).pipe(
      Effect.flatMap(cleanupJobWorkspace),
      Effect.match({ onFailure: () => "failed" as const, onSuccess: () => "deleted" as const }),
    ),
  );
  return outcomes.reduce(
    (totals, outcome) => ({
      deleted: totals.deleted + (outcome === "deleted" ? 1 : 0),
      failed: totals.failed + (outcome === "failed" ? 1 : 0),
    }),
    { deleted: 0, failed: 0 },
  );
});
