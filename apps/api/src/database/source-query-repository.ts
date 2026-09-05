import { Buffer } from "node:buffer";
import { NonNegativeIntegerSchema, type PreparedSourceListQuery } from "@densio/shared";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";
import { SourceRepositoryError } from "../sources/source-errors.ts";
import type { Database } from "./database.ts";
import { expireOwnedSourcesIfDue } from "./prepared-source-repository.ts";
import { preparedSources } from "./schema.ts";
import {
  authorizeOrganization,
  type OrganizationActor,
} from "../organizations/organization-access.ts";
import { OrganizationError } from "../organizations/organization-errors.ts";

export class InvalidSourceListCursor extends Schema.TaggedErrorClass<InvalidSourceListCursor>()(
  "InvalidSourceListCursor",
  {},
) {}
const CursorSchema = Schema.Struct({
  createdAt: NonNegativeIntegerSchema,
  id: Schema.NonEmptyString,
});

export const listOwnedPreparedSources = Effect.fn("SourceQueryRepository.list")(function* (
  database: Database,
  input: PreparedSourceListQuery & OrganizationActor & { readonly now: number },
) {
  const cursor =
    input.cursor === undefined
      ? undefined
      : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CursorSchema))(
          Buffer.from(input.cursor, "base64url").toString("utf8"),
        ).pipe(Effect.mapError(() => new InvalidSourceListCursor()));
  const limit = input.limit ?? 25;
  const rows = yield* Effect.try({
    catch: (cause) =>
      cause instanceof OrganizationError
        ? cause
        : new SourceRepositoryError({ cause, operation: "list-sources" }),
    try: () =>
      database.db.transaction(
        (transaction) => {
          authorizeOrganization(transaction, input, "media-read");
          expireOwnedSourcesIfDue(transaction, input.organizationId, input.now);
          return transaction
            .select()
            .from(preparedSources)
            .where(
              and(
                eq(preparedSources.organizationId, input.organizationId),
                input.state === undefined ? undefined : eq(preparedSources.state, input.state),
                input.since === undefined
                  ? undefined
                  : gte(preparedSources.createdAt, Date.parse(input.since)),
                cursor === undefined ? undefined : keysetBefore(cursor),
              ),
            )
            .orderBy(desc(preparedSources.createdAt), desc(preparedSources.id))
            .limit(limit + 1)
            .all();
        },
        { behavior: "immediate" },
      ),
  });
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    organizationId: input.organizationId,
    sources: page,
    ...(rows.length > limit && last !== undefined
      ? {
          nextCursor: Buffer.from(
            JSON.stringify({ createdAt: last.createdAt, id: last.id }),
          ).toString("base64url"),
        }
      : {}),
  };
});

const keysetBefore = (cursor: typeof CursorSchema.Type) =>
  // SQLite row-value comparison matches the compound descending order, including tied timestamps.
  sql`(${preparedSources.createdAt}, ${preparedSources.id}) < (${cursor.createdAt}, ${cursor.id})`;
