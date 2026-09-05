import { createHmac, randomUUID } from "node:crypto";
import type { StorageConnectionCreateRequest } from "@densio/shared";
import { and, eq } from "drizzle-orm";
import type { Database } from "../../database/database.ts";
import {
  storageConnections,
  storageConnectionOperations,
} from "../../database/video-storage-schema.ts";
import { canonicalDigest } from "../../idempotency/canonical-digest.ts";
import {
  authorizeOrganization,
  type OrganizationActor,
} from "../../organizations/organization-access.ts";
import { storageFailure } from "../storage-errors.ts";
import { sealStorageCredentials } from "./credentials.ts";
import { validateConnectionConfig, type ConnectionServiceConfig } from "./connection-config.ts";
import { projectConnection } from "./connection-catalog.ts";

export type CreateConnectionInput = OrganizationActor & {
  readonly request: StorageConnectionCreateRequest;
  readonly idempotencyKey: string;
};
export const connectionSecretDigest = (config: ConnectionServiceConfig, request: unknown) => {
  const key = config.credentialKeys[config.activeCredentialKey];
  if (!key)
    throw storageFailure(
      "STORAGE_NOT_CONFIGURED",
      "Storage credential encryption is not configured.",
    );
  return createHmac("sha256", key).update(canonicalDigest(request)).digest("hex");
};
export const createConnection = (
  database: Database,
  config: ConnectionServiceConfig,
  input: CreateConnectionInput,
) =>
  database.db.transaction(
    (transaction) => {
      authorizeOrganization(transaction, input, "storage-configure");
      validateConnectionConfig(input.request.config, config.allowedOrigins);
      const digest = connectionSecretDigest(config, input.request);
      const existing = transaction
        .select()
        .from(storageConnections)
        .where(
          and(
            eq(storageConnections.organizationId, input.organizationId),
            eq(storageConnections.idempotencyKey, input.idempotencyKey),
          ),
        )
        .get();
      if (existing) {
        if (!connectionDigestMatches(config, input.request, existing.requestDigest))
          throw storageFailure("IDEMPOTENCY_CONFLICT");
        return {
          organizationId: input.organizationId,
          replayed: true,
          connection: projectConnection(existing),
        };
      }
      const id = randomUUID();
      const now = config.now();
      const row = transaction
        .insert(storageConnections)
        .values({
          id,
          organizationId: input.organizationId,
          name: input.request.name,
          configJson: JSON.stringify(input.request.config),
          credentialsCiphertext: sealStorageCredentials(
            config.credentialKeys[config.activeCredentialKey] ?? "",
            { organizationId: input.organizationId, connectionId: id, version: 1 },
            {
              ...input.request.credentials,
              ...(input.request.stagingCredentials
                ? { staging: input.request.stagingCredentials }
                : {}),
            },
          ),
          credentialVersion: 1,
          encryptionKeyVersion: config.activeCredentialKey,
          state: "pending-validation",
          createdAt: now,
          updatedAt: now,
          idempotencyKey: input.idempotencyKey,
          requestDigest: digest,
        })
        .returning()
        .get();
      transaction
        .insert(storageConnectionOperations)
        .values({
          id: randomUUID(),
          organizationId: input.organizationId,
          connectionId: id,
          kind: "validate",
          state: "pending",
          idempotencyKey: `create:${input.idempotencyKey}`,
          requestDigest: digest,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return {
        organizationId: input.organizationId,
        replayed: false,
        connection: projectConnection(row),
      };
    },
    { behavior: "immediate" },
  );

export const connectionDigestMatches = (
  config: ConnectionServiceConfig,
  request: unknown,
  digest: string,
) =>
  Object.values(config.credentialKeys).some(
    (key) => createHmac("sha256", key).update(canonicalDigest(request)).digest("hex") === digest,
  );
