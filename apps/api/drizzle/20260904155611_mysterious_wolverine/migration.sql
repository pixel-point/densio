CREATE TABLE `job_write_activities` (
	`id` text PRIMARY KEY,
	`job_id` text NOT NULL,
	`process_id` integer NOT NULL,
	`process_identity` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_job_write_activities_job_id_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`)
);
--> statement-breakpoint
ALTER TABLE `jobs` ADD `workspace_cleaned_at` integer;--> statement-breakpoint
CREATE INDEX `job_write_activities_job_index` ON `job_write_activities` (`job_id`);--> statement-breakpoint
ALTER TABLE `jobs` DROP COLUMN `organization_cleaned_at`;