import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organization-schema.ts";

export const storageSettings = sqliteTable("storage_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id),
  destinationJson: text("destination_json").notNull().default('{"kind":"temporary"}'),
  visibility: text("visibility", { enum: ["public", "private"] })
    .notNull()
    .default("public"),
  policyRevision: integer("policy_revision").notNull().default(0),
  graceDeadline: integer("grace_deadline"),
  effectiveLimit: integer("effective_limit").notNull().default(0),
  notifiedJson: text("notified_json").notNull().default("[]"),
  updatedAt: integer("updated_at").notNull(),
});

export const storageConnections = sqliteTable(
  "storage_connections",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    configJson: text("config_json").notNull(),
    credentialsCiphertext: text("credentials_ciphertext"),
    credentialVersion: integer("credential_version").notNull().default(1),
    encryptionKeyVersion: text("encryption_key_version").notNull().default("primary"),
    state: text("state", {
      enum: ["pending-validation", "active", "error", "disabled", "disconnected"],
    }).notNull(),
    errorCode: text("error_code"),
    validatedAt: integer("validated_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
  },
  (table) => [
    uniqueIndex("storage_connections_org_key").on(table.organizationId, table.idempotencyKey),
    uniqueIndex("storage_connections_org_id").on(table.organizationId, table.id),
  ],
);

export const storageConnectionOperations = sqliteTable(
  "storage_connection_operations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    connectionId: text("connection_id").notNull(),
    kind: text("kind", { enum: ["validate", "rotate", "disable", "disconnect"] }).notNull(),
    state: text("state", { enum: ["pending", "running", "succeeded", "blocked"] }).notNull(),
    workerPid: integer("worker_pid"),
    workerIdentity: text("worker_identity"),
    leaseOwner: text("lease_owner"),
    candidateKeyVersion: text("candidate_key_version"),
    candidateCiphertext: text("candidate_ciphertext"),
    credentialVersion: integer("credential_version"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    progressJson: text("progress_json").notNull().default("{}"),
    errorCode: text("error_code"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.connectionId],
      foreignColumns: [storageConnections.organizationId, storageConnections.id],
    }),
    uniqueIndex("storage_connection_operations_key").on(table.organizationId, table.idempotencyKey),
  ],
);

export const videos = sqliteTable(
  "videos",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    jobId: text("job_id").notNull(),
    automaticJobId: text("automatic_job_id"),
    hlsPackageId: text("hls_package_id"),
    displayName: text("display_name").notNull(),
    filenameStem: text("filename_stem").notNull(),
    destinationJson: text("destination_json").notNull(),
    targetId: text("target_id").notNull(),
    connectionId: text("connection_id"),
    publicOrigin: text("public_origin"),
    visibility: text("visibility", { enum: ["public", "private"] }).notNull(),
    visibilityRevision: integer("visibility_revision").notNull().default(0),
    state: text("state", {
      enum: [
        "storing",
        "ready",
        "storage-blocked",
        "storage-failed",
        "unavailable",
        "visibility-changing",
        "deleting",
        "deleted",
      ],
    }).notNull(),
    transferId: text("transfer_id").notNull(),
    totalBytes: integer("total_bytes").notNull(),
    capacityState: text("capacity_state", { enum: ["none", "reserved", "used"] })
      .notNull()
      .default("none"),
    errorCode: text("error_code"),
    createdAt: integer("created_at").notNull(),
    storedAt: integer("stored_at"),
    deletedAt: integer("deleted_at"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
  },
  (table) => [
    uniqueIndex("videos_org_id").on(table.organizationId, table.id),
    uniqueIndex("videos_org_key").on(table.organizationId, table.idempotencyKey),
    uniqueIndex("videos_automatic_job").on(table.automaticJobId),
    index("videos_org_created").on(table.organizationId, table.createdAt, table.id),
    check("videos_total_bytes_positive", sql`${table.totalBytes} > 0`),
    foreignKey({
      columns: [table.organizationId, table.connectionId],
      foreignColumns: [storageConnections.organizationId, storageConnections.id],
    }),
  ],
);

export const videoVariants = sqliteTable(
  "video_variants",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    videoId: text("video_id").notNull(),
    artifactId: text("artifact_id"),
    filename: text("filename").notNull(),
    codec: text("codec", { enum: ["vp9", "h265", "av1"] }).notNull(),
    mediaType: text("media_type", { enum: ["video/webm", "video/mp4"] }).notNull(),
    bytes: integer("bytes").notNull(),
    sha256: text("sha256").notNull(),
    width: integer("width"),
    height: integer("height"),
    durationSeconds: real("duration_seconds"),
    inputObjectId: text("input_object_id"),
    inputPath: text("input_path"),
    inputExpiresAt: integer("input_expires_at").notNull(),
    activeObjectId: text("active_object_id"),
    publicKey: text("public_key").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.videoId],
      foreignColumns: [videos.organizationId, videos.id],
    }),
    uniqueIndex("video_variants_org_id").on(table.organizationId, table.id),
    uniqueIndex("video_variants_codec").on(table.videoId, table.codec),
  ],
);

export const videoPackageMembers = sqliteTable(
  "video_package_members",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    videoId: text("video_id").notNull(),
    artifactId: text("artifact_id"),
    filename: text("filename").notNull(),
    role: text("role", { enum: ["master", "playlist", "initialization", "segment"] }).notNull(),
    mediaType: text("media_type").notNull(),
    bytes: integer("bytes").notNull(),
    sha256: text("sha256").notNull(),
    inputObjectId: text("input_object_id"),
    inputPath: text("input_path"),
    inputExpiresAt: integer("input_expires_at").notNull(),
    activeObjectId: text("active_object_id"),
    publicKey: text("public_key").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.videoId],
      foreignColumns: [videos.organizationId, videos.id],
    }),
    uniqueIndex("video_package_members_org_id").on(table.organizationId, table.id),
    uniqueIndex("video_package_members_path").on(table.videoId, table.filename),
    index("video_package_members_input").on(table.inputObjectId),
  ],
);

export const storageTransfers = sqliteTable(
  "storage_transfers",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    videoId: text("video_id").notNull(),
    kind: text("kind", { enum: ["save", "export", "visibility", "delete"] }).notNull(),
    state: text("state", {
      enum: [
        "pending",
        "uploading",
        "verifying",
        "retry-wait",
        "blocked",
        "succeeded",
        "failed",
        "canceled",
      ],
    }).notNull(),
    revision: integer("revision").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    workerPid: integer("worker_pid"),
    workerIdentity: text("worker_identity"),
    leaseOwner: text("lease_owner"),
    nextAttemptAt: integer("next_attempt_at").notNull(),
    recoveryDeadline: integer("recovery_deadline").notNull(),
    intentJson: text("intent_json").notNull(),
    progressJson: text("progress_json").notNull().default("{}"),
    errorCode: text("error_code"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.videoId],
      foreignColumns: [videos.organizationId, videos.id],
    }),
    uniqueIndex("storage_transfers_org_key").on(table.organizationId, table.idempotencyKey),
    index("storage_transfers_pending").on(table.state, table.nextAttemptAt),
  ],
);

export const storageObjects = sqliteTable(
  "storage_objects",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    videoId: text("video_id"),
    variantId: text("variant_id"),
    packageMemberId: text("package_member_id"),
    transferId: text("transfer_id"),
    connectionId: text("connection_id"),
    targetId: text("target_id").notNull(),
    bucketRole: text("bucket_role", { enum: ["public", "private", "staging"] }).notNull(),
    bucket: text("bucket").notNull(),
    objectKey: text("object_key").notNull(),
    versionId: text("version_id"),
    state: text("state", {
      enum: ["planned", "creating", "uploading", "completed", "verified", "deleting", "deleted"],
    }).notNull(),
    revision: integer("revision").notNull().default(0),
    uploadId: text("upload_id"),
    partsJson: text("parts_json").notNull().default("[]"),
    etag: text("etag"),
    bytes: integer("bytes").notNull(),
    sha256: text("sha256").notNull(),
    publicUrl: text("public_url"),
    purgeAfter: integer("purge_after"),
    purgedAt: integer("purged_at"),
    createdAt: integer("created_at").notNull(),
    verifiedAt: integer("verified_at"),
    healthCheckAfter: integer("health_check_after").notNull().default(0),
    healthErrorCode: text("health_error_code"),
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    uniqueIndex("storage_objects_locator").on(table.targetId, table.bucket, table.objectKey),
    index("storage_objects_video").on(table.organizationId, table.videoId),
    foreignKey({
      columns: [table.organizationId, table.packageMemberId],
      foreignColumns: [videoPackageMembers.organizationId, videoPackageMembers.id],
    }),
    foreignKey({
      columns: [table.organizationId, table.variantId],
      foreignColumns: [videoVariants.organizationId, videoVariants.id],
    }),
  ],
);

export const videoAccessGrants = sqliteTable(
  "video_access_grants",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    variantId: text("variant_id").notNull(),
    membershipId: text("membership_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("video_access_grants_token").on(table.tokenHash),
    foreignKey({
      columns: [table.organizationId, table.variantId],
      foreignColumns: [videoVariants.organizationId, videoVariants.id],
    }),
  ],
);

export const hlsAccessGrants = sqliteTable(
  "hls_access_grants",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    videoId: text("video_id").notNull(),
    membershipId: text("membership_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    revision: integer("revision").notNull(),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.videoId],
      foreignColumns: [videos.organizationId, videos.id],
    }),
    uniqueIndex("hls_access_grants_token").on(table.tokenHash),
    index("hls_access_grants_expiry").on(table.expiresAt),
  ],
);

export const sourceObjectUploads = sqliteTable(
  "source_object_uploads",
  {
    sourceId: text("source_id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    connectionId: text("connection_id").notNull(),
    objectId: text("object_id")
      .notNull()
      .references(() => storageObjects.id),
    membershipId: text("membership_id").notNull().default(""),
    workerPid: integer("worker_pid"),
    workerIdentity: text("worker_identity"),
    leaseOwner: text("lease_owner"),
    nextAttemptAt: integer("next_attempt_at").notNull().default(0),
    state: text("state", {
      enum: ["creating", "uploading", "committing", "preparing", "ready", "failed", "expired"],
    }).notNull(),
    declaredBytes: integer("declared_bytes").notNull(),
    partSize: integer("part_size").notNull(),
    expiresAt: integer("expires_at").notNull(),
    errorCode: text("error_code"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.organizationId, table.connectionId],
      foreignColumns: [storageConnections.organizationId, storageConnections.id],
    }),
  ],
);

export const storageRequests = sqliteTable(
  "storage_requests",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    videoId: text("video_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("storage_requests_org_key").on(table.organizationId, table.idempotencyKey),
    foreignKey({
      columns: [table.organizationId, table.videoId],
      foreignColumns: [videos.organizationId, videos.id],
    }),
  ],
);

export const managedInventoryScans = sqliteTable("managed_inventory_scans", {
  id: text("id").primaryKey(),
  targetId: text("target_id").notNull(),
  bucketRole: text("bucket_role", { enum: ["public", "private", "staging"] }).notNull(),
  bucket: text("bucket").notNull(),
  cursor: text("cursor"),
  startedAt: integer("started_at"),
  nextRunAt: integer("next_run_at").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});
export const managedStorageOrphans = sqliteTable(
  "managed_storage_orphans",
  {
    id: text("id").primaryKey(),
    targetId: text("target_id").notNull(),
    bucketRole: text("bucket_role", { enum: ["public", "private", "staging"] }).notNull(),
    bucket: text("bucket").notNull(),
    objectKey: text("object_key").notNull(),
    bytes: integer("bytes").notNull(),
    etag: text("etag").notNull(),
    firstSeenAt: integer("first_seen_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
  },
  (table) => [
    uniqueIndex("managed_storage_orphans_locator").on(
      table.targetId,
      table.bucket,
      table.objectKey,
    ),
  ],
);

export const storageObjectReads = sqliteTable(
  "storage_object_reads",
  {
    id: text("id").primaryKey(),
    objectId: text("object_id")
      .notNull()
      .references(() => storageObjects.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    workerPid: integer("worker_pid").notNull(),
    workerIdentity: text("worker_identity").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("storage_object_reads_object").on(table.objectId)],
);
