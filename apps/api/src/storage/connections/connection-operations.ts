import { randomUUID } from "node:crypto";
import type { StorageCredentials } from "@densio/shared";
import { and, eq, inArray, ne } from "drizzle-orm";
import { Schema } from "effect";
import type { Database, DatabaseTransaction } from "../../database/database.ts";
import {
  sourceObjectUploads,
  storageConnections,
  storageConnectionOperations,
  storageSettings,
  storageTransfers,
  videos,
} from "../../database/video-storage-schema.ts";
import {
  authorizeOrganization,
  type OrganizationActor,
} from "../../organizations/organization-access.ts";
import { storageFailure } from "../storage-errors.ts";
import { connectionRow } from "./connection-catalog.ts";
import { connectionDigestMatches, connectionSecretDigest } from "./connection-create.ts";
import type { ConnectionServiceConfig } from "./connection-config.ts";
import { sealStorageCredentials } from "./credentials.ts";
import { connectionInputTransfers } from "../transfers/object-consumers.ts";
import { queueStorageDeletion } from "../managed/storage-retention.ts";

export type ConnectionOperationInput = OrganizationActor & {
  readonly connectionId: string;
  readonly idempotencyKey: string;
  readonly kind: "validate" | "rotate" | "disable" | "disconnect";
  readonly credentials?: StorageCredentials;
  readonly stagingCredentials?: StorageCredentials;
};
export const startConnectionOperation = (
  database: Database,
  config: ConnectionServiceConfig,
  input: ConnectionOperationInput,
) =>
  database.db.transaction(
    (transaction) => {
      authorizeOrganization(transaction, input, "storage-configure");
      const row = connectionRow(database, input.organizationId, input.connectionId);
      const digest = connectionSecretDigest(config, {
        connectionId: row.id,
        kind: input.kind,
        credentials: input.credentials,
        stagingCredentials: input.stagingCredentials,
      });
      const existing = transaction
        .select()
        .from(storageConnectionOperations)
        .where(
          and(
            eq(storageConnectionOperations.organizationId, input.organizationId),
            eq(storageConnectionOperations.idempotencyKey, input.idempotencyKey),
          ),
        )
        .get();
      if (existing) {
        if (
          !connectionDigestMatches(
            config,
            {
              connectionId: row.id,
              kind: input.kind,
              credentials: input.credentials,
              stagingCredentials: input.stagingCredentials,
            },
            existing.requestDigest,
          )
        )
          throw storageFailure("IDEMPOTENCY_CONFLICT");
        return projectConnectionOperation(existing);
      }
      if (row.state === "disconnected") throw storageFailure("STORAGE_CONNECTION_UNAVAILABLE");
      const busy = transaction
        .select()
        .from(storageConnectionOperations)
        .where(
          and(
            eq(storageConnectionOperations.connectionId, row.id),
            inArray(storageConnectionOperations.state, ["pending", "running"]),
          ),
        )
        .get();
      if (busy) throw storageFailure("STORAGE_BUSY");
      if (input.kind === "rotate" && !input.credentials) throw storageFailure("INVALID_REQUEST");
      const now = config.now();
      const operation = transaction
        .insert(storageConnectionOperations)
        .values({
          id: randomUUID(),
          organizationId: row.organizationId,
          connectionId: row.id,
          kind: input.kind,
          state: "pending",
          candidateKeyVersion: input.credentials ? config.activeCredentialKey : null,
          candidateCiphertext: input.credentials
            ? sealStorageCredentials(
                config.credentialKeys[config.activeCredentialKey] ?? "",
                {
                  organizationId: row.organizationId,
                  connectionId: row.id,
                  version: row.credentialVersion + 1,
                },
                {
                  ...input.credentials,
                  ...(input.stagingCredentials ? { staging: input.stagingCredentials } : {}),
                },
              )
            : null,
          credentialVersion: input.kind === "rotate" ? row.credentialVersion + 1 : null,
          idempotencyKey: input.idempotencyKey,
          requestDigest: digest,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      if (input.kind === "disable" || input.kind === "disconnect")
        disableConnectionWork(transaction, row, input.kind, now);
      return projectConnectionOperation(operation);
    },
    { behavior: "immediate" },
  );

const CleanupList = Schema.Array(
  Schema.Struct({
    bucket: Schema.String,
    key: Schema.String,
    uploadId: Schema.optionalKey(Schema.String),
  }),
);
const OperationProgress = Schema.Struct({ cleanupRequired: Schema.optionalKey(CleanupList) });
export const projectConnectionOperation = (
  operation: typeof storageConnectionOperations.$inferSelect,
) => ({
  organizationId: operation.organizationId,
  operation: {
    organizationId: operation.organizationId,
    operationId: operation.id,
    connectionId: operation.connectionId,
    kind: operation.kind,
    state: operation.state,
    ...(operation.errorCode === null ? {} : { errorCode: operation.errorCode }),
    cleanupRequired:
      Schema.decodeUnknownSync(Schema.fromJsonString(OperationProgress))(operation.progressJson)
        .cleanupRequired ?? [],
  },
});

const disableConnectionWork = (
  transaction: DatabaseTransaction,
  row: typeof storageConnections.$inferSelect,
  kind: "disable" | "disconnect",
  now: number,
) => {
  transaction
    .update(storageConnections)
    .set({ state: "disabled", updatedAt: now })
    .where(eq(storageConnections.id, row.id))
    .run();
  const settings = transaction
    .select()
    .from(storageSettings)
    .where(eq(storageSettings.organizationId, row.organizationId))
    .get();
  if (settings?.destinationJson === JSON.stringify({ kind: "connection", connectionId: row.id }))
    transaction
      .update(storageSettings)
      .set({ destinationJson: '{"kind":"temporary"}', updatedAt: now })
      .where(eq(storageSettings.organizationId, row.organizationId))
      .run();
  transaction
    .update(sourceObjectUploads)
    .set({ state: "expired", nextAttemptAt: now })
    .where(
      and(
        eq(sourceObjectUploads.connectionId, row.id),
        inArray(sourceObjectUploads.state, ["creating", "uploading", "committing", "preparing"]),
      ),
    )
    .run();
  if (kind === "disconnect") {
    connectionInputTransfers(transaction, row.id).forEach((transfer) => {
      if (transfer.kind !== "export" || ["succeeded", "canceled"].includes(transfer.state)) return;
      const video = transaction.select().from(videos).where(eq(videos.id, transfer.videoId)).get();
      if (video && video.transferId === transfer.id)
        queueStorageDeletion(transaction, video, now, { cleanup: true });
    });
    const ownedVideos = transaction
      .select()
      .from(videos)
      .where(eq(videos.connectionId, row.id))
      .all();
    ownedVideos.forEach((video) =>
      transaction
        .update(storageTransfers)
        .set({ state: "canceled", revision: video.visibilityRevision + 1 })
        .where(and(eq(storageTransfers.videoId, video.id), ne(storageTransfers.state, "succeeded")))
        .run(),
    );
  }
};
