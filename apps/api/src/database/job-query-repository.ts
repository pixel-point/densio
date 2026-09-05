import { Buffer } from "node:buffer";

import { NonNegativeIntegerSchema, type JobState, type JobWorkflow } from "@densio/shared";
import { and, desc, eq, gte, lt, or } from "drizzle-orm";
import { Effect, Schema } from "effect";

import { tryJobRepository } from "../jobs/job-effect-support.ts";
import type { Database } from "./database.ts";
import { jobs } from "./schema.ts";

export class InvalidJobListCursor extends Schema.TaggedErrorClass<InvalidJobListCursor>()(
  "InvalidJobListCursor",
  {},
) {}

interface ListOwnedJobsInput {
  readonly clientReference?: string;
  readonly cursor?: string;
  readonly idempotencyKey?: string;
  readonly limit: number;
  readonly since?: number;
  readonly state?: JobState;
  readonly organizationId: string;
  readonly workflow?: JobWorkflow;
}

type LookupOwnedJobInput =
  | {
      readonly clientReference: string;
      readonly idempotencyKey?: never;
      readonly organizationId: string;
    }
  | {
      readonly clientReference?: never;
      readonly idempotencyKey: string;
      readonly organizationId: string;
    };

const JobListCursorSchema = Schema.Struct({
  createdAt: NonNegativeIntegerSchema,
  id: Schema.NonEmptyString,
});
type JobListCursor = typeof JobListCursorSchema.Type;

export const listOwnedJobs = Effect.fn("JobQueryRepository.list")(function* (
  database: Database,
  input: ListOwnedJobsInput,
) {
  const cursor = input.cursor === undefined ? undefined : yield* decodeJobListCursor(input.cursor);
  const conditions = [
    eq(jobs.organizationId, input.organizationId),
    input.state === undefined ? undefined : eq(jobs.state, input.state),
    input.workflow === undefined ? undefined : eq(jobs.kind, input.workflow),
    input.since === undefined ? undefined : gte(jobs.createdAt, input.since),
    input.clientReference === undefined
      ? undefined
      : eq(jobs.clientReference, input.clientReference),
    input.idempotencyKey === undefined ? undefined : eq(jobs.idempotencyKey, input.idempotencyKey),
    cursor === undefined
      ? undefined
      : or(
          lt(jobs.createdAt, cursor.createdAt),
          and(eq(jobs.createdAt, cursor.createdAt), lt(jobs.id, cursor.id)),
        ),
  ];
  const rows = yield* tryJobRepository("list-owned", () =>
    database.db
      .select()
      .from(jobs)
      .where(and(...conditions))
      .orderBy(desc(jobs.createdAt), desc(jobs.id))
      .limit(input.limit + 1)
      .all(),
  );
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    jobs: page,
    ...(rows.length > input.limit && last !== undefined
      ? { nextCursor: encodeJobListCursor(last) }
      : {}),
  };
});

export const lookupOwnedJob = Effect.fn("JobQueryRepository.lookup")(function* (
  database: Database,
  input: LookupOwnedJobInput,
) {
  const selector =
    input.clientReference === undefined
      ? eq(jobs.idempotencyKey, input.idempotencyKey)
      : eq(jobs.clientReference, input.clientReference);
  return yield* tryJobRepository("lookup-owned", () =>
    database.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.organizationId, input.organizationId), selector))
      .get(),
  );
});

const decodeJobListCursor = Effect.fn("JobQueryRepository.decodeCursor")((cursor: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(JobListCursorSchema))(
    Buffer.from(cursor, "base64url").toString("utf8"),
  ).pipe(Effect.mapError(() => new InvalidJobListCursor())),
);

const encodeJobListCursor = (cursor: JobListCursor) =>
  Buffer.from(JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id })).toString("base64url");
