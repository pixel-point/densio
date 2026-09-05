import {
  type JobEventKind,
  type JobEventPage,
  JobProgressSchema,
  type JobProgress,
  type JobState,
} from "@densio/shared";
import { and, asc, eq, gt } from "drizzle-orm";
import { Effect, Schema } from "effect";

import { JobRepositoryError } from "../jobs/job-errors.ts";
import { tryJobRepository } from "../jobs/job-effect-support.ts";
import type { Database } from "./database.ts";
import { jobEvents, jobs } from "./schema.ts";

interface AppendJobEventInput {
  readonly attempt: number;
  readonly jobId: string;
  readonly kind: JobEventKind;
  readonly occurredAt: number;
  readonly progress: JobProgress;
  readonly state: JobState;
}

interface ListOwnedJobEventsInput {
  readonly after: number;
  readonly jobId: string;
  readonly limit: number;
  readonly organizationId: string;
}

type JobEventWriter = Pick<Database["db"], "insert">;

export const appendJobEvent = (writer: JobEventWriter, input: AppendJobEventInput) =>
  writer
    .insert(jobEvents)
    .values({
      attempt: input.attempt,
      jobId: input.jobId,
      kind: input.kind,
      occurredAt: input.occurredAt,
      progressJson: JSON.stringify(input.progress),
      state: input.state,
    })
    .returning()
    .get();

export const listOwnedJobEvents = Effect.fn("JobEventRepository.listOwned")(function* (
  database: Database,
  input: ListOwnedJobEventsInput,
) {
  const owned = yield* tryJobRepository("find-event-owner", () =>
    database.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.id, input.jobId), eq(jobs.organizationId, input.organizationId)))
      .get(),
  );
  if (owned === undefined) return undefined;

  const rows = yield* tryJobRepository("list-events", () =>
    database.db
      .select()
      .from(jobEvents)
      .where(and(eq(jobEvents.jobId, input.jobId), gt(jobEvents.sequence, input.after)))
      .orderBy(asc(jobEvents.sequence))
      .limit(input.limit)
      .all(),
  );
  const events = yield* Effect.forEach(rows, decodeJobEvent);
  return {
    organizationId: input.organizationId,
    events,
    nextCursor: events.at(-1)?.sequence ?? input.after,
  } satisfies JobEventPage;
});

const decodeJobEvent = Effect.fn("JobEventRepository.decodeStored")(function* (
  row: typeof jobEvents.$inferSelect,
) {
  const progress = yield* decodeStored(JobProgressSchema, row.progressJson, "progress");
  return {
    attempt: row.attempt,
    jobId: row.jobId,
    kind: row.kind,
    occurredAt: new Date(row.occurredAt).toISOString(),
    progress,
    sequence: row.sequence,
    state: row.state,
  };
});

const decodeStored = <S extends Schema.Top>(schema: S, value: string, field: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(value).pipe(
    Effect.mapError(
      (cause) => new JobRepositoryError({ cause, operation: `decode-event-${field}` }),
    ),
  );
