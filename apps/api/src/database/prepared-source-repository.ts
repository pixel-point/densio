import { and, asc, eq, gt, inArray, isNull, lte, notExists, notInArray, or } from "drizzle-orm";

import type { Database, DatabaseTransaction } from "./database.ts";
import { preparedSources, sourceWriteActivities } from "./schema.ts";
import {
  authorizeOrganization,
  type OrganizationActor,
} from "../organizations/organization-access.ts";
import { organizationFailure } from "../organizations/organization-errors.ts";

export const createPreparedSource = (
  database: Database,
  values: typeof preparedSources.$inferInsert,
  actor: OrganizationActor,
) =>
  database.db.transaction(
    (transaction) => {
      authorizeOrganization(transaction, actor, "media-write");
      if (values.organizationId !== actor.organizationId || values.createdByUserId !== actor.userId)
        throw organizationFailure(
          "ORGANIZATION_ACCESS_DENIED",
          "The source creation does not match its organization actor.",
        );
      const existing =
        values.idempotencyKey === null || values.idempotencyKey === undefined
          ? undefined
          : transaction
              .select()
              .from(preparedSources)
              .where(
                and(
                  eq(preparedSources.organizationId, values.organizationId),
                  eq(preparedSources.idempotencyKey, values.idempotencyKey),
                ),
              )
              .get();
      if (existing !== undefined) return { created: false as const, source: existing };
      const source = transaction.insert(preparedSources).values(values).returning().get();
      return { created: true as const, source };
    },
    { behavior: "immediate" },
  );

export const findOwnedPreparedSource = (
  { db }: Database,
  input: { readonly sourceId: string; readonly organizationId: string },
) =>
  db
    .select()
    .from(preparedSources)
    .where(
      and(
        eq(preparedSources.id, input.sourceId),
        eq(preparedSources.organizationId, input.organizationId),
      ),
    )
    .get();

export const findPreparedSourceByIdempotencyKey = (
  { db }: Database,
  organizationId: string,
  idempotencyKey: string,
) =>
  db
    .select()
    .from(preparedSources)
    .where(
      and(
        eq(preparedSources.organizationId, organizationId),
        eq(preparedSources.idempotencyKey, idempotencyKey),
      ),
    )
    .get();

export const claimPreparedSourceUpload = (
  { db }: Database,
  input: OrganizationActor & {
    readonly bytes: number;
    readonly now: number;
    readonly sha256: string;
    readonly sourceId: string;
    readonly stagingFile: string;
    readonly organizationId: string;
  },
) =>
  db.transaction(
    (transaction) => {
      authorizeOrganization(transaction, input, "media-write");
      return transaction
        .update(preparedSources)
        .set({
          inputBytes: input.bytes,
          inputSha256: input.sha256,
          updatedAt: input.now,
          uploadStagingFile: input.stagingFile,
          state: "finalizing",
        })
        .where(
          and(
            eq(preparedSources.id, input.sourceId),
            eq(preparedSources.organizationId, input.organizationId),
            eq(preparedSources.state, "awaiting-upload"),
            gt(preparedSources.uploadExpiresAt, input.now),
            gt(preparedSources.expiresAt, input.now),
          ),
        )
        .returning()
        .get();
    },
    { behavior: "immediate" },
  );

export const markPreparedSourceInspecting = ({ db }: Database, sourceId: string, now: number) =>
  db
    .update(preparedSources)
    .set({
      state: "inspecting",
      updatedAt: now,
      uploadStagingFile: null,
    })
    .where(and(eq(preparedSources.id, sourceId), eq(preparedSources.state, "finalizing")))
    .returning()
    .get();

export const completePreparedSourceInspection = (
  { db }: Database,
  input: { readonly inspectionJson: string; readonly now: number; readonly sourceId: string },
) =>
  db
    .update(preparedSources)
    .set({
      errorCode: null,
      errorJson: null,
      inspectionJson: input.inspectionJson,
      state: "ready",
      updatedAt: input.now,
    })
    .where(and(eq(preparedSources.id, input.sourceId), eq(preparedSources.state, "inspecting")))
    .returning()
    .get();

export const failPreparedSourceInspection = (
  { db }: Database,
  input: {
    readonly errorCode: string;
    readonly errorJson: string;
    readonly now: number;
    readonly sourceId: string;
  },
) =>
  db
    .update(preparedSources)
    .set({
      errorCode: input.errorCode,
      errorJson: input.errorJson,
      inspectionJson: null,
      state: "failed",
      updatedAt: input.now,
    })
    .where(and(eq(preparedSources.id, input.sourceId), eq(preparedSources.state, "inspecting")))
    .returning()
    .get();

export const listRecoverablePreparedSources = ({ db }: Database, limit: number, afterId?: string) =>
  db
    .select()
    .from(preparedSources)
    .where(
      and(
        inArray(preparedSources.state, ["finalizing", "inspecting"]),
        afterId === undefined ? undefined : gt(preparedSources.id, afterId),
      ),
    )
    .orderBy(asc(preparedSources.id))
    .limit(limit)
    .all();

export const deleteOwnedPreparedSource = (
  { db }: Database,
  sourceId: string,
  actor: OrganizationActor,
  now: number,
) =>
  db.transaction(
    (transaction) => {
      authorizeOrganization(transaction, actor, "media-write");
      const source = transaction
        .select()
        .from(preparedSources)
        .where(
          and(
            eq(preparedSources.id, sourceId),
            eq(preparedSources.organizationId, actor.organizationId),
          ),
        )
        .get();
      if (source === undefined || source.state === "deleted") return source;
      return transaction
        .update(preparedSources)
        .set({
          state: "deleted",
          deletedAt: now,
          updatedAt: now,
          cleanedAt: null,
        })
        .where(
          and(
            eq(preparedSources.id, sourceId),
            eq(preparedSources.organizationId, actor.organizationId),
          ),
        )
        .returning()
        .get();
    },
    { behavior: "immediate" },
  );

const dueSource = (now: number) =>
  and(
    notInArray(preparedSources.state, ["expired", "deleted"]),
    or(
      lte(preparedSources.expiresAt, now),
      and(eq(preparedSources.state, "awaiting-upload"), lte(preparedSources.uploadExpiresAt, now)),
    ),
  );

export const expireOwnedSourcesIfDue = (
  transaction: DatabaseTransaction,
  organizationId: string,
  now: number,
) =>
  transaction
    .update(preparedSources)
    .set({ state: "expired", updatedAt: now, cleanedAt: null })
    .where(and(eq(preparedSources.organizationId, organizationId), dueSource(now)))
    .run();

export const expireOwnedPreparedSourceIfDue = (
  { db }: Database,
  sourceId: string,
  organizationId: string,
  now: number,
) =>
  db
    .update(preparedSources)
    .set({ state: "expired", updatedAt: now, cleanedAt: null })
    .where(
      and(
        eq(preparedSources.id, sourceId),
        eq(preparedSources.organizationId, organizationId),
        dueSource(now),
      ),
    )
    .returning()
    .get();

export const expireDuePreparedSources = (
  database: Database,
  input: { readonly limit: number; readonly now: number },
) =>
  database.db.transaction(
    (transaction) => {
      const candidates = transaction
        .select({ id: preparedSources.id })
        .from(preparedSources)
        .where(dueSource(input.now))
        .orderBy(asc(preparedSources.expiresAt), asc(preparedSources.id))
        .limit(input.limit)
        .all();
      return candidates.flatMap(({ id }) => {
        const expired = transaction
          .update(preparedSources)
          .set({ state: "expired", updatedAt: input.now, cleanedAt: null })
          .where(and(eq(preparedSources.id, id), dueSource(input.now)))
          .returning()
          .get();
        return expired === undefined ? [] : [expired];
      });
    },
    { behavior: "immediate" },
  );

// Terminal state prevents new writers; existing writers must finish before deletion.
export const listSourceCleanupCandidates = ({ db }: Database, limit: number, afterId?: string) =>
  db
    .select()
    .from(preparedSources)
    .where(
      and(
        inArray(preparedSources.state, ["expired", "deleted", "failed"]),
        isNull(preparedSources.cleanedAt),
        notExists(
          db
            .select()
            .from(sourceWriteActivities)
            .where(eq(sourceWriteActivities.sourceId, preparedSources.id)),
        ),
        afterId === undefined ? undefined : gt(preparedSources.id, afterId),
      ),
    )
    .orderBy(asc(preparedSources.id))
    .limit(limit)
    .all();

export const markSourceCleaned = ({ db }: Database, sourceId: string, now: number) =>
  db
    .update(preparedSources)
    .set({ cleanedAt: now })
    .where(
      and(
        eq(preparedSources.id, sourceId),
        inArray(preparedSources.state, ["expired", "deleted", "failed"]),
        notExists(
          db
            .select()
            .from(sourceWriteActivities)
            .where(eq(sourceWriteActivities.sourceId, preparedSources.id)),
        ),
      ),
    )
    .run();
