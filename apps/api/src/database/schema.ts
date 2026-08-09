import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [uniqueIndex("users_email_unique").on(table.email)],
);

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
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    grantedBy: text("granted_by").notNull(),
    grantedAt: integer("granted_at").notNull(),
    revokedAt: integer("revoked_at"),
  },
  (table) => [index("admin_grants_user_index").on(table.userId)],
);

export const stripeCustomers = sqliteTable(
  "stripe_customers",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    customerId: text("customer_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [uniqueIndex("stripe_customers_customer_unique").on(table.customerId)],
);

export const stripeSubscriptions = sqliteTable(
  "stripe_subscriptions",
  {
    subscriptionId: text("subscription_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    customerId: text("customer_id").notNull(),
    priceId: text("price_id").notNull(),
    status: text("status").notNull(),
    cancelAtPeriodEnd: integer("cancel_at_period_end", { mode: "boolean" }).notNull(),
    currentPeriodEnd: integer("current_period_end"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("stripe_subscriptions_user_status_index").on(table.userId, table.status)],
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
    challengeId: text("challenge_id")
      .notNull()
      .references(() => authChallenges.id, { onDelete: "cascade" }),
    recipient: text("recipient").notNull(),
    encryptedConfirmationUrl: text("confirmation_url"),
    status: text("status", { enum: ["pending", "sending", "sent", "failed"] }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at").notNull(),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    sentAt: integer("sent_at"),
  },
  (table) => [
    uniqueIndex("email_outbox_challenge_unique").on(table.challengeId),
    index("email_outbox_pending_index").on(table.status, table.nextAttemptAt),
  ],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["compress", "extract-images", "compare-quality"] }).notNull(),
    state: text("state", {
      enum: [
        "awaiting-upload",
        "queued",
        "analyzing",
        "processing",
        "succeeded",
        "failed",
        "canceled",
        "expired",
      ],
    }).notNull(),
    plan: text("plan", { enum: ["free", "basic", "pro", "premium"] }).notNull(),
    queuePriority: integer("queue_priority").notNull().default(0),
    sourceFilename: text("source_filename").notNull(),
    declaredBytes: integer("declared_bytes").notNull(),
    maxUploadBytes: integer("max_upload_bytes").notNull().default(1_000_000_000),
    inputBytes: integer("input_bytes"),
    inputSha256: text("input_sha256"),
    uploadState: text("upload_state", { enum: ["pending", "finalizing"] })
      .notNull()
      .default("pending"),
    uploadStagingFile: text("upload_staging_file"),
    optionsJson: text("options_json").notNull(),
    idempotencyKey: text("idempotency_key"),
    progress: real("progress").notNull().default(0),
    attemptCount: integer("attempt_count").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at"),
    errorCode: text("error_code"),
    errorJson: text("error_json"),
    resultJson: text("result_json"),
    cancelRequestedAt: integer("cancel_requested_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
  },
  (table) => [
    uniqueIndex("jobs_user_idempotency_unique").on(table.userId, table.idempotencyKey),
    index("jobs_queue_index").on(table.state, table.queuePriority, table.createdAt),
    index("jobs_user_created_index").on(table.userId, table.createdAt),
  ],
);

export const jobCreditEntries = sqliteTable(
  "job_credit_entries",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    periodStart: integer("period_start").notNull(),
    kind: text("kind", { enum: ["hold", "adjustment", "release", "usage"] }).notNull(),
    units: integer("units").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("job_credit_entries_job_kind_unique").on(table.jobId, table.kind),
    index("job_credit_entries_user_period_index").on(table.userId, table.periodStart),
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
    outcome: text("outcome", { enum: ["running", "succeeded", "failed", "interrupted"] }).notNull(),
    errorCode: text("error_code"),
  },
  (table) => [uniqueIndex("job_attempts_job_attempt_unique").on(table.jobId, table.attempt)],
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    path: text("path").notNull(),
    filename: text("filename").notNull(),
    mediaType: text("media_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    accessTokenHash: text("access_token_hash").notNull(),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
    deletedAt: integer("deleted_at"),
    deletionError: text("deletion_error"),
  },
  (table) => [
    uniqueIndex("artifacts_access_hash_unique").on(table.accessTokenHash),
    index("artifacts_job_index").on(table.jobId),
    index("artifacts_expiry_index").on(table.expiresAt, table.deletedAt),
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
