CREATE TABLE `organization_audit_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`organization_id` text NOT NULL,
	`kind` text NOT NULL,
	`actor_json` text NOT NULL,
	`target_id` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`correlation_id` text NOT NULL,
	CONSTRAINT `fk_organization_audit_events_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`)
);
--> statement-breakpoint
CREATE TABLE `organization_creation_requests` (
	`user_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`organization_id` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_organization_creation_requests_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`),
	CONSTRAINT `fk_organization_creation_requests_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`)
);
--> statement-breakpoint
CREATE TABLE `organization_invitations` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`state` text NOT NULL,
	`invited_by_user_id` text NOT NULL,
	`accepted_membership_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_organization_invitations_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`),
	CONSTRAINT `fk_organization_invitations_invited_by_user_id_users_id_fk` FOREIGN KEY (`invited_by_user_id`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
CREATE TABLE `organization_memberships` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`is_default` integer NOT NULL,
	`joined_at` integer NOT NULL,
	CONSTRAINT `fk_organization_memberships_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`),
	CONSTRAINT `fk_organization_memberships_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`),
	CONSTRAINT "organization_memberships_role_check" CHECK("role" in ('owner','admin','member'))
);
--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`billing_email` text NOT NULL,
	`state` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deletion_requested_at` integer,
	`deleted_at` integer,
	`cleanup_error` text,
	CONSTRAINT `fk_organizations_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`),
	CONSTRAINT "organizations_state_check" CHECK("state" in ('active','deleting','deleted'))
);
--> statement-breakpoint
ALTER TABLE `admin_grants` ADD `organization_id` text NOT NULL REFERENCES organizations(id);--> statement-breakpoint
ALTER TABLE `artifact_access_grants` ADD `issuing_membership_id` text NOT NULL REFERENCES organization_memberships(id) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `execution_plans` ADD `created_by_user_id` text NOT NULL REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `execution_plans` ADD `organization_id` text NOT NULL REFERENCES organizations(id);--> statement-breakpoint
ALTER TABLE `job_credit_entries` ADD `organization_id` text NOT NULL REFERENCES organizations(id);--> statement-breakpoint
ALTER TABLE `jobs` ADD `created_by_user_id` text NOT NULL REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `jobs` ADD `organization_id` text NOT NULL REFERENCES organizations(id);--> statement-breakpoint
ALTER TABLE `prepared_sources` ADD `created_by_user_id` text NOT NULL REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `prepared_sources` ADD `organization_id` text NOT NULL REFERENCES organizations(id);--> statement-breakpoint
ALTER TABLE `stripe_customers` ADD `organization_id` text REFERENCES organizations(id);--> statement-breakpoint
ALTER TABLE `stripe_subscriptions` ADD `organization_id` text NOT NULL REFERENCES organizations(id);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_admin_grants` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`granted_by` text NOT NULL,
	`granted_at` integer NOT NULL,
	`revoked_at` integer,
	CONSTRAINT `fk_admin_grants_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_admin_grants`(`id`, `granted_by`, `granted_at`, `revoked_at`) SELECT `id`, `granted_by`, `granted_at`, `revoked_at` FROM `admin_grants`;--> statement-breakpoint
DROP TABLE `admin_grants`;--> statement-breakpoint
ALTER TABLE `__new_admin_grants` RENAME TO `admin_grants`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_execution_plans` (
	`id` text PRIMARY KEY,
	`created_by_user_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`source_id` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`supersedes_plan_id` text,
	`request_digest` text NOT NULL,
	`idempotency_key` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT `fk_execution_plans_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`),
	CONSTRAINT `fk_execution_plans_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`),
	CONSTRAINT `fk_execution_plans_source_id_prepared_sources_id_fk` FOREIGN KEY (`source_id`) REFERENCES `prepared_sources`(`id`),
	CONSTRAINT `fk_execution_plans_organization_id_source_id_prepared_sources_organization_id_id_fk` FOREIGN KEY (`organization_id`,`source_id`) REFERENCES `prepared_sources`(`organization_id`,`id`)
);
--> statement-breakpoint
INSERT INTO `__new_execution_plans`(`id`, `source_id`, `snapshot_json`, `supersedes_plan_id`, `request_digest`, `idempotency_key`, `created_at`, `expires_at`) SELECT `id`, `source_id`, `snapshot_json`, `supersedes_plan_id`, `request_digest`, `idempotency_key`, `created_at`, `expires_at` FROM `execution_plans`;--> statement-breakpoint
DROP TABLE `execution_plans`;--> statement-breakpoint
ALTER TABLE `__new_execution_plans` RENAME TO `execution_plans`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_job_credit_entries` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`job_id` text NOT NULL,
	`period_start` integer NOT NULL,
	`kind` text NOT NULL,
	`units` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_job_credit_entries_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`),
	CONSTRAINT `fk_job_credit_entries_job_id_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_job_credit_entries_organization_id_job_id_jobs_organization_id_id_fk` FOREIGN KEY (`organization_id`,`job_id`) REFERENCES `jobs`(`organization_id`,`id`)
);
--> statement-breakpoint
INSERT INTO `__new_job_credit_entries`(`id`, `job_id`, `period_start`, `kind`, `units`, `created_at`) SELECT `id`, `job_id`, `period_start`, `kind`, `units`, `created_at` FROM `job_credit_entries`;--> statement-breakpoint
DROP TABLE `job_credit_entries`;--> statement-breakpoint
ALTER TABLE `__new_job_credit_entries` RENAME TO `job_credit_entries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_jobs` (
	`id` text PRIMARY KEY,
	`created_by_user_id` text NOT NULL,
	`organization_id` text NOT NULL,
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
	CONSTRAINT `fk_jobs_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`),
	CONSTRAINT `fk_jobs_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`),
	CONSTRAINT `fk_jobs_source_id_prepared_sources_id_fk` FOREIGN KEY (`source_id`) REFERENCES `prepared_sources`(`id`),
	CONSTRAINT `fk_jobs_execution_plan_id_execution_plans_id_fk` FOREIGN KEY (`execution_plan_id`) REFERENCES `execution_plans`(`id`),
	CONSTRAINT `fk_jobs_organization_id_source_id_prepared_sources_organization_id_id_fk` FOREIGN KEY (`organization_id`,`source_id`) REFERENCES `prepared_sources`(`organization_id`,`id`),
	CONSTRAINT `fk_jobs_organization_id_execution_plan_id_execution_plans_organization_id_id_fk` FOREIGN KEY (`organization_id`,`execution_plan_id`) REFERENCES `execution_plans`(`organization_id`,`id`)
);
--> statement-breakpoint
INSERT INTO `__new_jobs`(`id`, `kind`, `state`, `plan`, `queue_priority`, `source_filename`, `declared_bytes`, `input_bytes`, `input_sha256`, `source_id`, `execution_plan_id`, `client_reference`, `idempotency_key`, `request_digest`, `requested_options_json`, `resolved_options_json`, `intent_digest`, `quote_credit_units`, `max_output_bytes`, `inspection_json`, `toolchain_json`, `progress_json`, `revision`, `attempt_count`, `lease_owner`, `lease_expires_at`, `error_code`, `error_json`, `result_json`, `receipt_json`, `cancel_requested_at`, `created_at`, `updated_at`, `started_at`, `completed_at`) SELECT `id`, `kind`, `state`, `plan`, `queue_priority`, `source_filename`, `declared_bytes`, `input_bytes`, `input_sha256`, `source_id`, `execution_plan_id`, `client_reference`, `idempotency_key`, `request_digest`, `requested_options_json`, `resolved_options_json`, `intent_digest`, `quote_credit_units`, `max_output_bytes`, `inspection_json`, `toolchain_json`, `progress_json`, `revision`, `attempt_count`, `lease_owner`, `lease_expires_at`, `error_code`, `error_json`, `result_json`, `receipt_json`, `cancel_requested_at`, `created_at`, `updated_at`, `started_at`, `completed_at` FROM `jobs`;--> statement-breakpoint
DROP TABLE `jobs`;--> statement-breakpoint
ALTER TABLE `__new_jobs` RENAME TO `jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_prepared_sources` (
	`id` text PRIMARY KEY,
	`created_by_user_id` text NOT NULL,
	`organization_id` text NOT NULL,
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
	CONSTRAINT `fk_prepared_sources_created_by_user_id_users_id_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`),
	CONSTRAINT `fk_prepared_sources_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_prepared_sources`(`id`, `state`, `source_filename`, `declared_bytes`, `max_upload_bytes`, `input_bytes`, `input_sha256`, `upload_staging_file`, `inspection_json`, `error_code`, `error_json`, `idempotency_key`, `request_digest`, `upload_expires_at`, `expires_at`, `created_at`, `updated_at`, `deleted_at`, `cleaned_at`) SELECT `id`, `state`, `source_filename`, `declared_bytes`, `max_upload_bytes`, `input_bytes`, `input_sha256`, `upload_staging_file`, `inspection_json`, `error_code`, `error_json`, `idempotency_key`, `request_digest`, `upload_expires_at`, `expires_at`, `created_at`, `updated_at`, `deleted_at`, `cleaned_at` FROM `prepared_sources`;--> statement-breakpoint
DROP TABLE `prepared_sources`;--> statement-breakpoint
ALTER TABLE `__new_prepared_sources` RENAME TO `prepared_sources`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_stripe_customers` (
	`organization_id` text PRIMARY KEY,
	`customer_id` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_stripe_customers_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_stripe_customers`(`customer_id`, `created_at`) SELECT `customer_id`, `created_at` FROM `stripe_customers`;--> statement-breakpoint
DROP TABLE `stripe_customers`;--> statement-breakpoint
ALTER TABLE `__new_stripe_customers` RENAME TO `stripe_customers`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_stripe_subscriptions` (
	`subscription_id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`price_id` text NOT NULL,
	`status` text NOT NULL,
	`cancel_at_period_end` integer NOT NULL,
	`current_period_end` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_stripe_subscriptions_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`)
);
--> statement-breakpoint
INSERT INTO `__new_stripe_subscriptions`(`subscription_id`, `customer_id`, `price_id`, `status`, `cancel_at_period_end`, `current_period_end`, `updated_at`) SELECT `subscription_id`, `customer_id`, `price_id`, `status`, `cancel_at_period_end`, `current_period_end`, `updated_at` FROM `stripe_subscriptions`;--> statement-breakpoint
DROP TABLE `stripe_subscriptions`;--> statement-breakpoint
ALTER TABLE `__new_stripe_subscriptions` RENAME TO `stripe_subscriptions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
DROP INDEX IF EXISTS `admin_grants_user_index`;--> statement-breakpoint
DROP INDEX IF EXISTS `execution_plans_user_idempotency_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `execution_plans_user_created_index`;--> statement-breakpoint
DROP INDEX IF EXISTS `job_credit_entries_user_period_index`;--> statement-breakpoint
DROP INDEX IF EXISTS `jobs_user_idempotency_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `jobs_user_client_reference_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `jobs_user_created_id_index`;--> statement-breakpoint
DROP INDEX IF EXISTS `jobs_user_state_created_index`;--> statement-breakpoint
DROP INDEX IF EXISTS `jobs_user_kind_created_index`;--> statement-breakpoint
DROP INDEX IF EXISTS `prepared_sources_user_idempotency_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `prepared_sources_user_created_index`;--> statement-breakpoint
DROP INDEX IF EXISTS `stripe_subscriptions_user_status_index`;--> statement-breakpoint
CREATE INDEX `admin_grants_organization_index` ON `admin_grants` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `executionPlans_organization_id_unique` ON `execution_plans` (`organization_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `execution_plans_organization_idempotency_unique` ON `execution_plans` (`organization_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `execution_plans_organization_created_index` ON `execution_plans` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `execution_plans_source_created_index` ON `execution_plans` (`source_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `job_credit_entries_job_kind_unique` ON `job_credit_entries` (`job_id`,`kind`);--> statement-breakpoint
CREATE INDEX `job_credit_entries_organization_period_index` ON `job_credit_entries` (`organization_id`,`period_start`);--> statement-breakpoint
CREATE INDEX `job_credit_entries_job_index` ON `job_credit_entries` (`job_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_organization_id_unique` ON `jobs` (`organization_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_organization_idempotency_unique` ON `jobs` (`organization_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_organization_client_reference_unique` ON `jobs` (`organization_id`,`client_reference`);--> statement-breakpoint
CREATE INDEX `jobs_queue_index` ON `jobs` (`state`,`queue_priority`,`created_at`);--> statement-breakpoint
CREATE INDEX `jobs_organization_created_id_index` ON `jobs` (`organization_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `jobs_organization_state_created_index` ON `jobs` (`organization_id`,`state`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `jobs_organization_kind_created_index` ON `jobs` (`organization_id`,`kind`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `preparedSources_organization_id_unique` ON `prepared_sources` (`organization_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `prepared_sources_organization_idempotency_unique` ON `prepared_sources` (`organization_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `prepared_sources_organization_created_index` ON `prepared_sources` (`organization_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `prepared_sources_recovery_index` ON `prepared_sources` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `prepared_sources_expiry_index` ON `prepared_sources` (`state`,`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `stripe_customers_customer_unique` ON `stripe_customers` (`customer_id`);--> statement-breakpoint
CREATE INDEX `stripe_subscriptions_organization_status_index` ON `stripe_subscriptions` (`organization_id`,`status`);--> statement-breakpoint
CREATE INDEX `organization_audit_sequence_index` ON `organization_audit_events` (`organization_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_creation_requests_key_unique` ON `organization_creation_requests` (`user_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `organization_creation_requests_rate_index` ON `organization_creation_requests` (`user_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_invitations_pending_unique` ON `organization_invitations` (`organization_id`,`email`) WHERE "organization_invitations"."state" = 'pending';--> statement-breakpoint
CREATE INDEX `organization_invitations_recipient_index` ON `organization_invitations` (`email`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `organization_invitations_org_created_index` ON `organization_invitations` (`organization_id`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_memberships_org_user_unique` ON `organization_memberships` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_memberships_owner_unique` ON `organization_memberships` (`organization_id`) WHERE "organization_memberships"."role" = 'owner';--> statement-breakpoint
CREATE UNIQUE INDEX `organization_memberships_default_unique` ON `organization_memberships` (`user_id`) WHERE "organization_memberships"."is_default" = 1;--> statement-breakpoint
CREATE INDEX `organization_memberships_user_joined_index` ON `organization_memberships` (`user_id`,`joined_at`,`id`);--> statement-breakpoint
CREATE INDEX `organizations_state_created_index` ON `organizations` (`state`,`created_at`,`id`);