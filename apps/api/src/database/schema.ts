import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { users } from "./identity-schema.ts";
import { organizations, organizationMemberships } from "./organization-schema.ts";
export { users } from "./identity-schema.ts";
export {
  billingOperations,
  billingCustomerRequests,
  billingCheckoutAttempts,
  billingReconciliations,
} from "./organization-billing-schema.ts";
export {
  organizations,
  organizationMemberships,
  organizationAuditEvents,
  organizationCreationRequests,
  organizationInvitations,
} from "./organization-schema.ts";

export const authChallenges = sqliteTable(
  "auth_challenges",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    confirmationTokenHash: text("confirmation_token_hash").notNull(),
    pollingTokenHash: text("polling_token_hash").notNull(),
    requestIpHash: text("request_ip_hash").notNull(),
    status: text("status", { enum: ["pending", "confirmed", "consumed", "expired"] }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: integer("expires_at").notNull(),
    confirmedAt: integer("confirmed_at"),
    consumedAt: integer("consumed_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("auth_challenges_confirmation_hash_unique").on(table.confirmationTokenHash),
    uniqueIndex("auth_challenges_polling_hash_unique").on(table.pollingTokenHash),
    index("auth_challenges_email_created_index").on(table.email, table.createdAt),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    familyId: text("family_id").notNull(),
    accessTokenHash: text("access_token_hash").notNull(),
    accessExpiresAt: integer("access_expires_at").notNull(),
    refreshExpiresAt: integer("refresh_expires_at").notNull(),
    revokedAt: integer("revoked_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("sessions_access_hash_unique").on(table.accessTokenHash),
    index("sessions_user_index").on(table.userId),
  ],
);

export const sessionRefreshTokens = sqliteTable(
  "session_refresh_tokens",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    status: text("status", { enum: ["active", "rotated", "revoked"] }).notNull(),
    expiresAt: integer("expires_at").notNull(),
    rotatedAt: integer("rotated_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("session_refresh_tokens_hash_unique").on(table.tokenHash),
    index("session_refresh_tokens_session_index").on(table.sessionId),
  ],
);

export const adminGrants = sqliteTable(
  "admin_grants",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    grantedBy: text("granted_by").notNull(),
    grantedAt: integer("granted_at").notNull(),
    revokedAt: integer("revoked_at"),
  },
  (table) => [index("admin_grants_organization_index").on(table.organizationId)],
);

export const stripeCustomers = sqliteTable(
  "stripe_customers",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .references(() => organizations.id),
    customerId: text("customer_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [uniqueIndex("stripe_customers_customer_unique").on(table.customerId)],
);

export const stripeSubscriptions = sqliteTable(
  "stripe_subscriptions",
  {
    subscriptionId: text("subscription_id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    customerId: text("customer_id").notNull(),
    priceId: text("price_id").notNull(),
    status: text("status").notNull(),
    cancelAtPeriodEnd: integer("cancel_at_period_end", { mode: "boolean" }).notNull(),
    currentPeriodEnd: integer("current_period_end"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("stripe_subscriptions_organization_status_index").on(table.organizationId, table.status),
  ],
);

export const stripeEvents = sqliteTable("stripe_events", {
  eventId: text("event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  processedAt: integer("processed_at").notNull(),
});

export const emailOutbox = sqliteTable(
  "email_outbox",
  {
    id: text("id").primaryKey(),
    resourceKey: text("resource_key").notNull(),
    recipient: text("recipient").notNull(),
    payloadJson: text("payload_json"),
    status: text("status", { enum: ["pending", "sending", "sent", "failed"] }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at").notNull(),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    sentAt: integer("sent_at"),
  },
  (table) => [
    uniqueIndex("email_outbox_resource_unique").on(table.resourceKey),
    index("email_outbox_pending_index").on(table.status, table.nextAttemptAt),
  ],
);

export const preparedSources = sqliteTable(
  "prepared_sources",
  {
    id: text("id").primaryKey(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    state: text("state", {
      enum: [
        "awaiting-upload",
        "finalizing",
        "inspecting",
        "ready",
        "failed",
        "deleted",
        "expired",
      ],
    }).notNull(),
    sourceFilename: text("source_filename").notNull(),
    declaredBytes: integer("declared_bytes").notNull(),
    maxUploadBytes: integer("max_upload_bytes").notNull(),
    inputBytes: integer("input_bytes"),
    inputSha256: text("input_sha256"),
    uploadStagingFile: text("upload_staging_file"),
    inspectionJson: text("inspection_json"),
    errorCode: text("error_code"),
    errorJson: text("error_json"),
    idempotencyKey: text("idempotency_key"),
    requestDigest: text("request_digest").notNull(),
    uploadExpiresAt: integer("upload_expires_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
    cleanedAt: integer("cleaned_at"),
  },
  (table) => [
    uniqueIndex("preparedSources_organization_id_unique").on(table.organizationId, table.id),
    uniqueIndex("prepared_sources_organization_idempotency_unique").on(
      table.organizationId,
      table.idempotencyKey,
    ),
    index("prepared_sources_organization_created_index").on(
      table.organizationId,
      table.createdAt,
      table.id,
    ),
    index("prepared_sources_recovery_index").on(table.state, table.createdAt),
    index("prepared_sources_expiry_index").on(table.state, table.expiresAt),
    index("prepared_sources_pending_cleanup_index")
      .on(table.state, table.id)
      .where(sql`${table.cleanedAt} is null`),
  ],
);

export const sourceWriteActivities = sqliteTable(
  "source_write_activities",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => preparedSources.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    processId: integer("process_id").notNull(),
    processIdentity: text("process_identity").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("source_write_activities_org_index").on(table.organizationId),
    index("source_write_activities_source_index").on(table.sourceId),
  ],
);

export const executionPlans = sqliteTable(
  "execution_plans",
  {
    id: text("id").primaryKey(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    sourceId: text("source_id")
      .notNull()
      .references(() => preparedSources.id),
    snapshotJson: text("snapshot_json").notNull(),
    supersedesPlanId: text("supersedes_plan_id"),
    requestDigest: text("request_digest").notNull(),
    idempotencyKey: text("idempotency_key"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    uniqueIndex("executionPlans_organization_id_unique").on(table.organizationId, table.id),
    foreignKey({
      columns: [table.organizationId, table.sourceId],
      foreignColumns: [preparedSources.organizationId, preparedSources.id],
    }),
    uniqueIndex("execution_plans_organization_idempotency_unique").on(
      table.organizationId,
      table.idempotencyKey,
    ),
    index("execution_plans_organization_created_index").on(table.organizationId, table.createdAt),
    index("execution_plans_source_created_index").on(table.sourceId, table.createdAt),
  ],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    workspaceCleanedAt: integer("workspace_cleaned_at"),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    kind: text("kind", {
      enum: ["compress", "extract-images", "compare-quality", "hls", "trim"],
    }).notNull(),
    state: text("state", {
      enum: [
        "preparing",
        "queued",
        "analyzing",
        "processing",
        "publishing",
        "succeeded",
        "failed",
        "canceled",
      ],
    }).notNull(),
    subscriptionPlan: text("plan", { enum: ["free", "basic", "pro", "scale"] }).notNull(),
    queuePriority: integer("queue_priority").notNull().default(0),
    sourceFilename: text("source_filename").notNull(),
    declaredBytes: integer("declared_bytes").notNull(),
    inputBytes: integer("input_bytes").notNull(),
    inputSha256: text("input_sha256").notNull(),
    sourceId: text("source_id")
      .notNull()
      .references(() => preparedSources.id),
    executionPlanId: text("execution_plan_id")
      .notNull()
      .references(() => executionPlans.id),
    clientReference: text("client_reference"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    requestedOptionsJson: text("requested_options_json").notNull(),
    resolvedOptionsJson: text("resolved_options_json").notNull(),
    intentDigest: text("intent_digest").notNull(),
    quoteCreditUnits: integer("quote_credit_units").notNull(),
    maxOutputBytes: integer("max_output_bytes"),
    inspectionJson: text("inspection_json").notNull(),
    toolchainJson: text("toolchain_json"),
    progressJson: text("progress_json").notNull(),
    revision: integer("revision").notNull().default(0),
    attemptCount: integer("attempt_count").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at"),
    errorCode: text("error_code"),
    errorJson: text("error_json"),
    resultJson: text("result_json"),
    receiptJson: text("receipt_json"),
    cancelRequestedAt: integer("cancel_requested_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
  },
  (table) => [
    uniqueIndex("jobs_organization_id_unique").on(table.organizationId, table.id),
    foreignKey({
      columns: [table.organizationId, table.sourceId],
      foreignColumns: [preparedSources.organizationId, preparedSources.id],
    }),
    foreignKey({
      columns: [table.organizationId, table.executionPlanId],
      foreignColumns: [executionPlans.organizationId, executionPlans.id],
    }),
    uniqueIndex("jobs_organization_idempotency_unique").on(
      table.organizationId,
      table.idempotencyKey,
    ),
    uniqueIndex("jobs_organization_client_reference_unique").on(
      table.organizationId,
      table.clientReference,
    ),
    index("jobs_queue_index").on(table.state, table.queuePriority, table.createdAt),
    index("jobs_pending_cleanup_index")
      .on(table.state, table.id)
      .where(sql`${table.workspaceCleanedAt} is null`),
    index("jobs_organization_created_id_index").on(table.organizationId, table.createdAt, table.id),
    index("jobs_organization_state_created_index").on(
      table.organizationId,
      table.state,
      table.createdAt,
      table.id,
    ),
    index("jobs_organization_kind_created_index").on(
      table.organizationId,
      table.kind,
      table.createdAt,
      table.id,
    ),
  ],
);

export const jobWriteActivities = sqliteTable(
  "job_write_activities",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    processId: integer("process_id").notNull(),
    processIdentity: text("process_identity").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("job_write_activities_job_index").on(table.jobId)],
);

export const jobEvents = sqliteTable(
  "job_events",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: ["created", "state-changed", "artifact-published", "progress", "terminal"],
    }).notNull(),
    state: text("state", {
      enum: [
        "preparing",
        "queued",
        "analyzing",
        "processing",
        "publishing",
        "succeeded",
        "failed",
        "canceled",
      ],
    }).notNull(),
    progressJson: text("progress_json").notNull(),
    attempt: integer("attempt").notNull(),
    occurredAt: integer("occurred_at").notNull(),
  },
  (table) => [index("job_events_job_sequence_index").on(table.jobId, table.sequence)],
);

export const jobCreditEntries = sqliteTable(
  "job_credit_entries",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    periodStart: integer("period_start").notNull(),
    kind: text("kind", { enum: ["hold", "release", "usage"] }).notNull(),
    units: integer("units").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("job_credit_entries_job_kind_unique").on(table.jobId, table.kind),
    foreignKey({
      columns: [table.organizationId, table.jobId],
      foreignColumns: [jobs.organizationId, jobs.id],
    }),
    index("job_credit_entries_organization_period_index").on(
      table.organizationId,
      table.periodStart,
    ),
    index("job_credit_entries_job_index").on(table.jobId),
  ],
);

export const jobAttempts = sqliteTable(
  "job_attempts",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    workerId: text("worker_id").notNull(),
    startedAt: integer("started_at").notNull(),
    completedAt: integer("completed_at"),
    outcome: text("outcome", {
      enum: ["running", "succeeded", "failed", "interrupted"],
    }).notNull(),
    errorCode: text("error_code"),
  },
  (table) => [uniqueIndex("job_attempts_job_attempt_unique").on(table.jobId, table.attempt)],
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    path: text("path").notNull(),
    filename: text("filename").notNull(),
    mediaType: text("media_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    retainedUntil: integer("retained_until").notNull(),
    codec: text("codec"),
    width: integer("width"),
    height: integer("height"),
    durationSeconds: real("duration_seconds"),
    createdAt: integer("created_at").notNull(),
    deletedAt: integer("deleted_at"),
    deletionError: text("deletion_error"),
  },
  (table) => [
    index("artifacts_job_index").on(table.jobId),
    foreignKey({
      columns: [table.organizationId, table.jobId],
      foreignColumns: [jobs.organizationId, jobs.id],
    }),
    index("artifacts_retention_index").on(table.retainedUntil, table.deletedAt),
    index("artifacts_pending_cleanup_index")
      .on(table.id)
      .where(sql`${table.deletionError} is not null`),
  ],
);

export const artifactAccessGrants = sqliteTable(
  "artifact_access_grants",
  {
    issuingMembershipId: text("issuing_membership_id")
      .notNull()
      .references(() => organizationMemberships.id, { onDelete: "cascade" }),
    id: text("id").primaryKey(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("artifact_access_grants_token_unique").on(table.tokenHash),
    index("artifact_access_grants_artifact_expiry_index").on(table.artifactId, table.expiresAt),
  ],
);

export const mediaCommands = sqliteTable(
  "media_commands",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    tool: text("tool", { enum: ["ffmpeg", "ffprobe"] }).notNull(),
    executable: text("executable").notNull(),
    argumentsJson: text("arguments_json").notNull(),
    displayCommand: text("display_command").notNull(),
    startedAt: integer("started_at").notNull(),
    completedAt: integer("completed_at"),
    exitCode: integer("exit_code"),
    stderrTail: text("stderr_tail"),
  },
  (table) => [index("media_commands_job_attempt_index").on(table.jobId, table.attempt)],
);

export {
  storageRequests,
  managedInventoryScans,
  managedStorageOrphans,
  storageObjectReads,
  storageSettings,
  storageConnections,
  storageConnectionOperations,
  videos,
  videoVariants,
  videoPackageMembers,
  storageTransfers,
  storageObjects,
  videoAccessGrants,
  hlsAccessGrants,
  sourceObjectUploads,
} from "./video-storage-schema.ts";

export const hlsPackages = sqliteTable(
  "hls_packages",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    directory: text("directory").notNull(),
    inventoryJson: text("inventory_json").notNull(),
    packageBytes: integer("package_bytes").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("hls_packages_job").on(table.jobId),
    uniqueIndex("hls_packages_artifact").on(table.artifactId),
  ],
);
