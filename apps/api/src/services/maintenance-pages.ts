import { Effect, Exit } from "effect";

// Advance by immutable identity even when a page contains persistent failures.
export const runMaintenancePages = <
  Row extends { readonly id: string },
  ListError,
  ListRequirements,
  ItemError,
  ItemRequirements,
>(
  list: (page: {
    readonly afterId: string | undefined;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<Row>, ListError, ListRequirements>,
  process: (row: Row) => Effect.Effect<unknown, ItemError, ItemRequirements>,
  operation: string,
) =>
  Effect.gen(function* () {
    let afterId: string | undefined;
    const totals = { deleted: 0, failed: 0 };
    while (true) {
      const rows = yield* list({ afterId, limit: 50 });
      const last = rows.at(-1);
      if (last === undefined) return totals;
      const outcomes = yield* Effect.forEach(rows, (row) => process(row).pipe(Effect.exit), {
        concurrency: 4,
      });
      const failures = outcomes.filter(Exit.isFailure).length;
      totals.deleted += outcomes.length - failures;
      totals.failed += failures;
      if (failures > 0)
        yield* Effect.logWarning(`${operation}: ${failures} items remain pending for retry.`);
      afterId = last.id;
    }
  });
