import {
  createStoredSource,
  type CreateStorageSourceInput,
} from "../../sources/source-ingestion-state.ts";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import type { Database } from "../../database/database.ts";
import { preparedSources } from "../../database/schema.ts";
import { sourceObjectUploads, storageObjects } from "../../database/video-storage-schema.ts";
import {
  authorizeOrganization,
  type OrganizationActor,
} from "../../organizations/organization-access.ts";
import { connectionRow } from "../connections/connection-catalog.ts";
import { storageEffect, storageFailure, storagePromise } from "../storage-errors.ts";
import type { SourceUploadConfig } from "./source-upload-config.ts";

export type SourceUploadInput = OrganizationActor & { readonly sourceId: string };
export const makeSourceUploadService = (database: Database, config: SourceUploadConfig) => ({
  create: Effect.fn("SourceStorage.create")(function* (input: CreateStorageSourceInput) {
    const result = yield* storageEffect("source-upload-service", () =>
      createStoredSource(database, config, input),
    );
    const source = yield* config.sourceService.status({ ...input, sourceId: result.id });
    return { organizationId: input.organizationId, replayed: result.replayed, source };
  }),
  status: (input: SourceUploadInput) =>
    storagePromise("source-upload-service", async (signal) => {
      const { session, object } = ownedSourceUpload(database, input);
      const target =
        session.state === "uploading"
          ? await config.resolveTarget(object.targetId, "staging")
          : undefined;
      const parts =
        target && object.uploadId
          ? await target.store
              .listParts(object.objectKey, object.uploadId, signal)
              .finally(() => target.store.close())
          : [];
      return projectSourceUpload(session, parts);
    }),
  parts: (input: SourceUploadInput & { readonly partNumbers: readonly number[] }) =>
    storagePromise("source-upload-service", async () => {
      const { session, object } = writableUpload(database, config, input);
      if (session.state !== "uploading" || !object.uploadId) throw storageFailure("STORAGE_BUSY");
      if (
        input.partNumbers.length > 4 ||
        !input.partNumbers.length ||
        new Set(input.partNumbers).size !== input.partNumbers.length ||
        input.partNumbers.some(
          (part) =>
            !Number.isInteger(part) ||
            part < 1 ||
            part > Math.ceil(session.declaredBytes / session.partSize),
        )
      )
        throw storageFailure("INVALID_REQUEST");
      const target = await config.resolveTarget(object.targetId, "staging");
      const expiresIn = Math.min(900, Math.floor((session.expiresAt - config.now()) / 1000));
      if (expiresIn < 1) {
        target.store.close();
        throw storageFailure("STORAGE_ACCESS_EXPIRED");
      }
      const actions = await Promise.all(
        input.partNumbers.map(async (partNumber) => {
          const bytes = Math.min(
            session.partSize,
            session.declaredBytes - (partNumber - 1) * session.partSize,
          );
          return {
            partNumber,
            bytes,
            method: "PUT" as const,
            url: await target.store.signPart(
              object.objectKey,
              object.uploadId!,
              partNumber,
              bytes,
              expiresIn,
            ),
            expiresAt: new Date(config.now() + expiresIn * 1000).toISOString(),
            headers: { "content-length": String(bytes) },
          };
        }),
      ).finally(() => target.store.close());
      writableUpload(database, config, input);
      return { organizationId: input.organizationId, sourceId: input.sourceId, actions };
    }),
  commit: (input: SourceUploadInput) =>
    storageEffect("source-upload-service", () =>
      database.db.transaction(
        (transaction) => {
          const { session } = ownedSourceUpload(database, input);
          if (["committing", "preparing", "ready"].includes(session.state))
            return projectSourceUpload(session, []);
          writableUpload(database, config, input);
          if (session.state !== "uploading") throw storageFailure("STORAGE_BUSY");
          transaction
            .update(sourceObjectUploads)
            .set({ state: "committing", nextAttemptAt: config.now() })
            .where(eq(sourceObjectUploads.sourceId, session.sourceId))
            .run();
          return projectSourceUpload({ ...session, state: "committing" }, []);
        },
        { behavior: "immediate" },
      ),
    ),
});

export const ownedSourceUpload = (database: Database, input: SourceUploadInput) => {
  authorizeOrganization(database.db, input, "media-write");
  const session = database.db
    .select()
    .from(sourceObjectUploads)
    .where(
      and(
        eq(sourceObjectUploads.sourceId, input.sourceId),
        eq(sourceObjectUploads.organizationId, input.organizationId),
      ),
    )
    .get();
  const object = session
    ? database.db.select().from(storageObjects).where(eq(storageObjects.id, session.objectId)).get()
    : undefined;
  if (!session || !object) throw storageFailure("VIDEO_NOT_FOUND");
  return { session, object };
};
const writableUpload = (
  database: Database,
  config: SourceUploadConfig,
  input: SourceUploadInput,
) => {
  const result = ownedSourceUpload(database, input);
  const source = database.db
    .select()
    .from(preparedSources)
    .where(eq(preparedSources.id, input.sourceId))
    .get();
  if (result.session.expiresAt <= config.now()) throw storageFailure("STORAGE_ACCESS_EXPIRED");
  if (
    source?.state !== "awaiting-upload" ||
    !["creating", "uploading"].includes(result.session.state)
  )
    throw storageFailure("STORAGE_INVALID_STATE");
  if (connectionRow(database, input.organizationId, result.session.connectionId).state !== "active")
    throw storageFailure("STORAGE_CONNECTION_UNAVAILABLE");
  return result;
};
export const projectSourceUpload = (
  session: typeof sourceObjectUploads.$inferSelect,
  parts: readonly { partNumber: number; bytes: number }[],
) => ({
  organizationId: session.organizationId,
  session: {
    organizationId: session.organizationId,
    sourceId: session.sourceId,
    connectionId: session.connectionId,
    state: session.state,
    partSize: session.partSize,
    totalParts: Math.ceil(session.declaredBytes / session.partSize),
    expiresAt: new Date(session.expiresAt).toISOString(),
    uploadedParts: parts
      .filter(
        (part) =>
          part.bytes ===
          Math.min(
            session.partSize,
            session.declaredBytes - (part.partNumber - 1) * session.partSize,
          ),
      )
      .map(({ partNumber, bytes }) => ({ partNumber, bytes })),
    ...(session.errorCode ? { errorCode: session.errorCode } : {}),
  },
});
