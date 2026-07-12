CREATE TABLE `admin_grants` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`granted_by` text NOT NULL,
	`granted_at` integer NOT NULL,
	`revoked_at` integer,
	CONSTRAINT `fk_admin_grants_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY,
	`job_id` text NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`filename` text NOT NULL,
	`media_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`access_token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	`deletion_error` text,
	CONSTRAINT `fk_artifacts_job_id_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `auth_challenges` (
	`id` text PRIMARY KEY,
	`email` text NOT NULL,
	`confirmation_token_hash` text NOT NULL,
	`polling_token_hash` text NOT NULL,
	`request_ip_hash` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`confirmed_at` integer,
	`consumed_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `email_outbox` (
	`id` text PRIMARY KEY,
	`challenge_id` text NOT NULL,
	`recipient` text NOT NULL,
	`confirmation_url` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	CONSTRAINT `fk_email_outbox_challenge_id_auth_challenges_id_fk` FOREIGN KEY (`challenge_id`) REFERENCES `auth_challenges`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `job_attempts` (
	`id` text PRIMARY KEY,
	`job_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`worker_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`outcome` text NOT NULL,
	`error_code` text,
	CONSTRAINT `fk_job_attempts_job_id_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`plan` text NOT NULL,
	`source_filename` text NOT NULL,
	`declared_bytes` integer NOT NULL,
	`input_bytes` integer,
	`input_sha256` text,
	`options_json` text NOT NULL,
	`idempotency_key` text,
	`progress` real DEFAULT 0 NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`error_code` text,
	`error_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	CONSTRAINT `fk_jobs_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `media_commands` (
	`id` text PRIMARY KEY,
	`job_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`tool` text NOT NULL,
	`executable` text NOT NULL,
	`arguments_json` text NOT NULL,
	`display_command` text NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`exit_code` integer,
	`stderr_tail` text,
	CONSTRAINT `fk_media_commands_job_id_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `session_refresh_tokens` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`status` text NOT NULL,
	`expires_at` integer NOT NULL,
	`rotated_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_session_refresh_tokens_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`family_id` text NOT NULL,
	`access_token_hash` text NOT NULL,
	`access_expires_at` integer NOT NULL,
	`refresh_expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `stripe_customers` (
	`user_id` text PRIMARY KEY,
	`customer_id` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_stripe_customers_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `stripe_events` (
	`event_id` text PRIMARY KEY,
	`event_type` text NOT NULL,
	`processed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stripe_subscriptions` (
	`subscription_id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`price_id` text NOT NULL,
	`status` text NOT NULL,
	`cancel_at_period_end` integer NOT NULL,
	`current_period_end` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_stripe_subscriptions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY,
	`email` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `admin_grants_user_index` ON `admin_grants` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_access_hash_unique` ON `artifacts` (`access_token_hash`);--> statement-breakpoint
CREATE INDEX `artifacts_job_index` ON `artifacts` (`job_id`);--> statement-breakpoint
CREATE INDEX `artifacts_expiry_index` ON `artifacts` (`expires_at`,`deleted_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `auth_challenges_confirmation_hash_unique` ON `auth_challenges` (`confirmation_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `auth_challenges_polling_hash_unique` ON `auth_challenges` (`polling_token_hash`);--> statement-breakpoint
CREATE INDEX `auth_challenges_email_created_index` ON `auth_challenges` (`email`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `email_outbox_challenge_unique` ON `email_outbox` (`challenge_id`);--> statement-breakpoint
CREATE INDEX `email_outbox_pending_index` ON `email_outbox` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `job_attempts_job_attempt_unique` ON `job_attempts` (`job_id`,`attempt`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_user_idempotency_unique` ON `jobs` (`user_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `jobs_queue_index` ON `jobs` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `jobs_user_created_index` ON `jobs` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `media_commands_job_attempt_index` ON `media_commands` (`job_id`,`attempt`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_refresh_tokens_hash_unique` ON `session_refresh_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `session_refresh_tokens_session_index` ON `session_refresh_tokens` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_access_hash_unique` ON `sessions` (`access_token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_index` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_customers_customer_unique` ON `stripe_customers` (`customer_id`);--> statement-breakpoint
CREATE INDEX `stripe_subscriptions_user_status_index` ON `stripe_subscriptions` (`user_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);