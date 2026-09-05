import {
  startConnectionOperation,
  projectConnectionOperation,
  type ConnectionOperationInput,
} from "./connection-operations.ts";
import { and, eq } from "drizzle-orm";
import type { Database } from "../../database/database.ts";
import {
  storageConnectionOperations,
  storageConnections,
} from "../../database/video-storage-schema.ts";
import {
  authorizeOrganization,
  type OrganizationActor,
} from "../../organizations/organization-access.ts";
import { storageEffect, storageFailure } from "../storage-errors.ts";
import { createConnection, type CreateConnectionInput } from "./connection-create.ts";
import { connectionRow, projectConnection } from "./connection-catalog.ts";
import type { ConnectionServiceConfig } from "./connection-config.ts";

export const makeStorageConnectionService = (
  database: Database,
  config: ConnectionServiceConfig,
) => ({
  operation: (input: OrganizationActor & { readonly operationId: string }) =>
    storageEffect("connection-service", () => {
      authorizeOrganization(database.db, input, "media-read", true);
      const operation = database.db
        .select()
        .from(storageConnectionOperations)
        .where(
          and(
            eq(storageConnectionOperations.organizationId, input.organizationId),
            eq(storageConnectionOperations.id, input.operationId),
          ),
        )
        .get();
      if (!operation) throw storageFailure("STORAGE_CONNECTION_UNAVAILABLE");
      return projectConnectionOperation(operation);
    }),
  operate: (input: ConnectionOperationInput) =>
    storageEffect("connection-service", () => startConnectionOperation(database, config, input)),
  create: (input: CreateConnectionInput) =>
    storageEffect("connection-service", () => createConnection(database, config, input)),
  get: (input: OrganizationActor & { readonly connectionId: string }) =>
    storageEffect("connection-service", () => {
      authorizeOrganization(database.db, input, "media-read", true);
      return {
        organizationId: input.organizationId,
        connection: projectConnection(
          connectionRow(database, input.organizationId, input.connectionId),
        ),
      };
    }),
  list: (input: OrganizationActor) =>
    storageEffect("connection-service", () => {
      authorizeOrganization(database.db, input, "media-read", true);
      return {
        organizationId: input.organizationId,
        connections: database.db
          .select()
          .from(storageConnections)
          .where(eq(storageConnections.organizationId, input.organizationId))
          .all()
          .map(projectConnection),
      };
    }),
});
