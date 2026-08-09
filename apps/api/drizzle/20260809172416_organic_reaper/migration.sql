CREATE TABLE `job_credit_entries` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`job_id` text NOT NULL,
	`period_start` integer NOT NULL,
	`kind` text NOT NULL,
	`units` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_job_credit_entries_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_job_credit_entries_job_id_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `jobs` ADD `queue_priority` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DROP INDEX `jobs_queue_index`;--> statement-breakpoint
CREATE INDEX `jobs_queue_index` ON `jobs` (`state`,`queue_priority`,`created_at`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `max_upload_bytes` integer DEFAULT 1000000000 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `upload_state` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `upload_staging_file` text;--> statement-breakpoint
CREATE UNIQUE INDEX `job_credit_entries_job_kind_unique` ON `job_credit_entries` (`job_id`,`kind`);--> statement-breakpoint
CREATE INDEX `job_credit_entries_user_period_index` ON `job_credit_entries` (`user_id`,`period_start`);--> statement-breakpoint
CREATE INDEX `job_credit_entries_job_index` ON `job_credit_entries` (`job_id`);
