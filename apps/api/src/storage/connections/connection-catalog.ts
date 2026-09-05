import { StorageConnectionConfigSchema, StorageConnectionSchema } from "@densio/shared";
import { and, eq } from "drizzle-orm";
import { Schema } from "effect";
import type { Database } from "../../database/database.ts";
import { storageConnections } from "../../database/video-storage-schema.ts";
import { storageFailure } from "../storage-errors.ts";

export const connectionRow = (database: Database, organizationId: string, connectionId: string) => {
  const row = database.db
    .select()
    .from(storageConnections)
    .where(
      and(
        eq(storageConnections.id, connectionId),
        eq(storageConnections.organizationId, organizationId),
      ),
    )
    .get();
  if (!row) throw storageFailure("STORAGE_CONNECTION_UNAVAILABLE");
  return row;
};
export const requireActiveConnection = (
  database: Database,
  organizationId: string,
  connectionId: string,
) => {
  const row = connectionRow(database, organizationId, connectionId);
  if (row.state !== "active") throw storageFailure("STORAGE_CONNECTION_UNAVAILABLE");
  return row;
};
export const projectConnection = (row: typeof storageConnections.$inferSelect) =>
  Schema.decodeUnknownSync(StorageConnectionSchema)({
    organizationId: row.organizationId,
    connectionId: row.id,
    name: row.name,
    config: decodeConnectionConfig(row.configJson),
    state: row.state,
    credentialVersion: row.credentialVersion,
    createdAt: new Date(row.createdAt).toISOString(),
    ...(row.validatedAt === null ? {} : { validatedAt: new Date(row.validatedAt).toISOString() }),
    ...(row.errorCode === null ? {} : { errorCode: row.errorCode }),
  });
export const decodeConnectionConfig = Schema.decodeUnknownSync(
  Schema.fromJsonString(StorageConnectionConfigSchema),
);
