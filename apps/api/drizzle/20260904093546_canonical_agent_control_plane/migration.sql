CREATE TABLE `artifact_access_grants` (
	`id` text PRIMARY KEY,
	`artifact_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_artifact_access_grants_artifact_id_artifacts_id_fk` FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `execution_plans` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`source_id` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`supersedes_plan_id` text,
	`request_digest` text NOT NULL,
	`idempotency_key` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT `fk_execution_plans_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_execution_plans_source_id_prepared_sources_id_fk` FOREIGN KEY (`source_id`) REFERENCES `prepared_sources`(`id`)
);
--> statement-breakpoint
CREATE TABLE `job_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`job_id` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`progress_json` text NOT NULL,
	`attempt` integer NOT NULL,
	`occurred_at` integer NOT NULL,
	CONSTRAINT `fk_job_events_job_id_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `prepared_sources` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`state` text NOT NULL,
	`source_filename` text NOT NULL,
	`declared_bytes` integer NOT NULL,
	`max_upload_bytes` integer NOT NULL,
	`input_bytes` integer,
	`input_sha256` text,
	`upload_staging_file` text,
	`inspection_json` text,
	`error_code` text,
	`error_json` text,
	`idempotency_key` text,
	`request_digest` text NOT NULL,
	`upload_expires_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`cleaned_at` integer,
	CONSTRAINT `fk_prepared_sources_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `artifacts` RENAME COLUMN `expires_at` TO `retained_until`;--> statement-breakpoint
ALTER TABLE `artifacts` ADD `codec` text;--> statement-breakpoint
ALTER TABLE `artifacts` ADD `width` integer;--> statement-breakpoint
ALTER TABLE `artifacts` ADD `height` integer;--> statement-breakpoint
ALTER TABLE `artifacts` ADD `duration_seconds` real;--> statement-breakpoint
ALTER TABLE `jobs` ADD `source_id` text NOT NULL REFERENCES prepared_sources(id);--> statement-breakpoint
ALTER TABLE `jobs` ADD `execution_plan_id` text NOT NULL REFERENCES execution_plans(id);--> statement-breakpoint
ALTER TABLE `jobs` ADD `client_reference` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `request_digest` text NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `requested_options_json` text NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `resolved_options_json` text NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `intent_digest` text NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `quote_credit_units` integer NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `max_output_bytes` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `inspection_json` text NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `toolchain_json` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `progress_json` text NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `receipt_json` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_jobs` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`plan` text NOT NULL,
	`queue_priority` integer DEFAULT 0 NOT NULL,
	`source_filename` text NOT NULL,
	`declared_bytes` integer NOT NULL,
	`input_bytes` integer NOT NULL,
	`input_sha256` text NOT NULL,
	`source_id` text NOT NULL,
	`execution_plan_id` text NOT NULL,
	`client_reference` text,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`requested_options_json` text NOT NULL,
	`resolved_options_json` text NOT NULL,
	`intent_digest` text NOT NULL,
	`quote_credit_units` integer NOT NULL,
	`max_output_bytes` integer,
	`inspection_json` text NOT NULL,
	`toolchain_json` text,
	`progress_json` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`error_code` text,
	`error_json` text,
	`result_json` text,
	`receipt_json` text,
	`cancel_requested_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	CONSTRAINT `fk_jobs_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_jobs_source_id_prepared_sources_id_fk` FOREIGN KEY (`source_id`) REFERENCES `prepared_sources`(`id`),
	CONSTRAINT `fk_jobs_execution_plan_id_execution_plans_id_fk` FOREIGN KEY (`execution_plan_id`) REFERENCES `execution_plans`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_jobs`(`id`, `user_id`, `kind`, `state`, `plan`, `queue_priority`, `source_filename`, `declared_bytes`, `input_bytes`, `input_sha256`, `idempotency_key`, `attempt_count`, `lease_owner`, `lease_expires_at`, `error_code`, `error_json`, `result_json`, `cancel_requested_at`, `created_at`, `updated_at`, `started_at`, `completed_at`) SELECT `id`, `user_id`, `kind`, `state`, `plan`, `queue_priority`, `source_filename`, `declared_bytes`, `input_bytes`, `input_sha256`, `idempotency_key`, `attempt_count`, `lease_owner`, `lease_expires_at`, `error_code`, `error_json`, `result_json`, `cancel_requested_at`, `created_at`, `updated_at`, `started_at`, `completed_at` FROM `jobs`;--> statement-breakpoint
DROP TABLE `jobs`;--> statement-breakpoint
ALTER TABLE `__new_jobs` RENAME TO `jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
DROP INDEX IF EXISTS `artifacts_access_hash_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `artifacts_expiry_index`;--> statement-breakpoint
DROP INDEX IF EXISTS `jobs_user_created_index`;--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_user_idempotency_unique` ON `jobs` (`user_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_user_client_reference_unique` ON `jobs` (`user_id`,`client_reference`);--> statement-breakpoint
CREATE INDEX `jobs_queue_index` ON `jobs` (`state`,`queue_priority`,`created_at`);--> statement-breakpoint
CREATE INDEX `jobs_user_created_id_index` ON `jobs` (`user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `jobs_user_state_created_index` ON `jobs` (`user_id`,`state`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `jobs_user_kind_created_index` ON `jobs` (`user_id`,`kind`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_access_grants_token_unique` ON `artifact_access_grants` (`token_hash`);--> statement-breakpoint
CREATE INDEX `artifact_access_grants_artifact_expiry_index` ON `artifact_access_grants` (`artifact_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `artifacts_retention_index` ON `artifacts` (`retained_until`,`deleted_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `execution_plans_user_idempotency_unique` ON `execution_plans` (`user_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `execution_plans_user_created_index` ON `execution_plans` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `execution_plans_source_created_index` ON `execution_plans` (`source_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `job_events_job_sequence_index` ON `job_events` (`job_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `prepared_sources_user_idempotency_unique` ON `prepared_sources` (`user_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `prepared_sources_user_created_index` ON `prepared_sources` (`user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `prepared_sources_recovery_index` ON `prepared_sources` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `prepared_sources_expiry_index` ON `prepared_sources` (`state`,`expires_at`);--> statement-breakpoint
ALTER TABLE `artifacts` DROP COLUMN `access_token_hash`;