import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import type { Database, DatabaseTransaction } from "../database/database.ts";
import { organizationMemberships, organizations, preparedSources } from "../database/schema.ts";
import {
  sourceObjectUploads,
  storageConnections,
  storageObjects,
} from "../database/video-storage-schema.ts";
import { canonicalDigest } from "../idempotency/canonical-digest.ts";
import {
  authorizeOrganization,
  type OrganizationActor,
} from "../organizations/organization-access.ts";
import {
  connectionRow,
  decodeConnectionConfig,
} from "../storage/connections/connection-catalog.ts";
import { storageFailure } from "../storage/storage-errors.ts";
import { MULTIPART_PART_BYTES } from "../storage/objects/multipart-policy.ts";
import { SourceRepositoryError, SourceStateConflict } from "./source-errors.ts";

export type CreateStorageSourceInput = OrganizationActor & {
  readonly filename: string;
  readonly bytes: number;
  readonly uploadStorage: string;
  readonly idempotencyKey?: string;
  readonly correlationId: string;
  readonly maxUploadBytes: number;
  readonly now: number;
};
export const createStoredSource = (
  database: Database,
  config: {
    readonly now: () => number;
    readonly uploadTtlMs: number;
    readonly sourceTtlMs: number;
  },
  input: CreateStorageSourceInput,
): { id: string; replayed: boolean } =>
  database.db.transaction(
    (transaction) => {
      authorizeOrganization(transaction, input, "media-write");
      const digest = canonicalDigest({
        filename: input.filename,
        bytes: input.bytes,
        uploadStorage: input.uploadStorage,
      });
      const previous = replaySourceUpload(transaction, input, digest);
      if (previous) return previous;
      admitSourceUpload(transaction, input);
      const connection = connectionRow(database, input.organizationId, input.uploadStorage);
      const definition = decodeConnectionConfig(connection.configJson);
      if (connection.state !== "active") throw storageFailure("STORAGE_CONNECTION_UNAVAILABLE");
      if (!definition.staging) throw storageFailure("STORAGE_PRIVATE_STAGING_REQUIRED");
      const id = randomUUID();
      const objectId = randomUUID();
      const now = config.now();
      const expiresAt = Math.min(now + config.uploadTtlMs, now + config.sourceTtlMs);
      transaction
        .insert(preparedSources)
        .values({
          id,
          organizationId: input.organizationId,
          createdByUserId: input.userId,
          sourceFilename: input.filename,
          declaredBytes: input.bytes,
          maxUploadBytes: input.maxUploadBytes,
          state: "awaiting-upload",
          createdAt: now,
          updatedAt: now,
          expiresAt: now + config.sourceTtlMs,
          uploadExpiresAt: expiresAt,
          idempotencyKey: input.idempotencyKey ?? null,
          requestDigest: digest,
        })
        .run();
      transaction
        .insert(storageObjects)
        .values({
          id: objectId,
          organizationId: input.organizationId,
          connectionId: connection.id,
          targetId: `connection:${connection.id}`,
          bucketRole: "staging",
          bucket: definition.staging.bucket,
          objectKey: [
            definition.staging.prefix,
            "densio",
            input.organizationId,
            connection.id,
            "uploads",
            id,
            `${randomUUID()}-source`,
          ]
            .filter(Boolean)
            .join("/"),
          state: "planned",
          bytes: input.bytes,
          sha256: "",
          createdAt: now,
        })
        .run();
      transaction
        .insert(sourceObjectUploads)
        .values({
          sourceId: id,
          organizationId: input.organizationId,
          connectionId: connection.id,
          membershipId: input.membershipId,
          objectId,
          state: "creating",
          declaredBytes: input.bytes,
          partSize: MULTIPART_PART_BYTES,
          expiresAt,
          createdAt: now,
        })
        .run();
      return { id, replayed: false };
    },
    { behavior: "immediate" },
  );

const replaySourceUpload = (
  transaction: DatabaseTransaction,
  input: CreateStorageSourceInput,
  digest: string,
) => {
  const existing = input.idempotencyKey
    ? transaction
        .select()
        .from(preparedSources)
        .where(
          and(
            eq(preparedSources.organizationId, input.organizationId),
            eq(preparedSources.idempotencyKey, input.idempotencyKey),
          ),
        )
        .get()
    : undefined;
  if (existing) {
    if (existing.requestDigest !== digest) throw storageFailure("IDEMPOTENCY_CONFLICT");
    return { id: existing.id, replayed: true };
  }
};

const admitSourceUpload = (transaction: DatabaseTransaction, input: CreateStorageSourceInput) => {
  const pending = transaction
    .select({ id: sourceObjectUploads.sourceId })
    .from(sourceObjectUploads)
    .where(
      and(
        eq(sourceObjectUploads.organizationId, input.organizationId),
        inArray(sourceObjectUploads.state, ["creating", "uploading", "committing", "preparing"]),
      ),
    )
    .limit(4)
    .all();
  if (pending.length >= 4) throw storageFailure("STORAGE_UPLOAD_LIMIT_EXCEEDED");
  if (input.bytes > input.maxUploadBytes)
    throw storageFailure("INVALID_REQUEST", "The source exceeds this plan's upload limit.");
};
export const sourceUploadExpired = (
  database: Database,
  session: typeof sourceObjectUploads.$inferSelect,
  now: number,
) => {
  const source = database.db
    .select()
    .from(preparedSources)
    .where(eq(preparedSources.id, session.sourceId))
    .get();
  const connection = database.db
    .select()
    .from(storageConnections)
    .where(eq(storageConnections.id, session.connectionId))
    .get();
  const membership = database.db
    .select()
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.id, session.membershipId),
        eq(organizationMemberships.organizationId, session.organizationId),
      ),
    )
    .get();
  const organization = database.db
    .select()
    .from(organizations)
    .where(eq(organizations.id, session.organizationId))
    .get();
  return (
    !source ||
    source.expiresAt <= now ||
    ["deleted", "expired", "failed"].includes(source.state) ||
    (["creating", "uploading"].includes(session.state) && session.expiresAt <= now) ||
    connection?.state !== "active" ||
    !membership ||
    organization?.state !== "active" ||
    session.state === "expired"
  );
};
export const assertSourceUploadActive = (
  database: Database,
  session: typeof sourceObjectUploads.$inferSelect,
  now: number,
) => {
  const current = database.db
    .select()
    .from(sourceObjectUploads)
    .where(eq(sourceObjectUploads.sourceId, session.sourceId))
    .get();
  if (
    !current ||
    current.leaseOwner !== session.leaseOwner ||
    sourceUploadExpired(database, current, now)
  )
    throw storageFailure("STORAGE_ACCESS_EXPIRED");
};
export const finishUnusableSource = (
  database: Database,
  session: typeof sourceObjectUploads.$inferSelect,
  state: "expired" | "failed",
  now: number,
) => {
  database.db
    .update(preparedSources)
    .set({ state, updatedAt: now })
    .where(
      and(
        eq(preparedSources.id, session.sourceId),
        inArray(preparedSources.state, ["awaiting-upload", "finalizing", "inspecting"]),
      ),
    )
    .run();
};
export const failSourceUpload = (
  database: Database,
  session: typeof sourceObjectUploads.$inferSelect,
  code: string,
  now: number,
) => {
  const current = database.db
    .select()
    .from(sourceObjectUploads)
    .where(eq(sourceObjectUploads.sourceId, session.sourceId))
    .get();
  if (current?.leaseOwner !== session.leaseOwner) return;
  const state =
    sourceUploadExpired(database, current, now) || code === "STORAGE_ACCESS_EXPIRED"
      ? "expired"
      : ["STORAGE_OBJECT_CHANGED", "STORAGE_PERMISSION_DENIED"].includes(code)
        ? "failed"
        : undefined;
  database.db
    .update(sourceObjectUploads)
    .set({ errorCode: code, nextAttemptAt: now + 60_000, ...(state ? { state } : {}) })
    .where(eq(sourceObjectUploads.sourceId, session.sourceId))
    .run();
  if (state) finishUnusableSource(database, session, state, now);
};

export const assertSourceIngestion = (
  database: Database,
  sourceId: string,
  storageObjectId?: string,
) =>
  Effect.try({
    try: () =>
      database.db
        .select()
        .from(sourceObjectUploads)
        .where(eq(sourceObjectUploads.sourceId, sourceId))
        .get(),
    catch: (cause) => new SourceRepositoryError({ cause, operation: "read-upload-session" }),
  }).pipe(
    Effect.flatMap((session) =>
      session && (session.objectId !== storageObjectId || session.state !== "preparing")
        ? Effect.fail(new SourceStateConflict({ state: "awaiting-upload" }))
        : Effect.void,
    ),
  );

export const expireSourceIngestion = (database: Database, sourceId: string, now: number) => {
  database.db
    .update(sourceObjectUploads)
    .set({ state: "expired", nextAttemptAt: now })
    .where(eq(sourceObjectUploads.sourceId, sourceId))
    .run();
};

export const extendSourceIngestionDeadline = (
  transaction: DatabaseTransaction,
  source: typeof preparedSources.$inferSelect,
) => {
  transaction
    .update(preparedSources)
    .set({ uploadExpiresAt: source.expiresAt })
    .where(and(eq(preparedSources.id, source.id), eq(preparedSources.state, "awaiting-upload")))
    .run();
};
