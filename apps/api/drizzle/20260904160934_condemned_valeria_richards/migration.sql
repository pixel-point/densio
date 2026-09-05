CREATE INDEX `artifacts_pending_cleanup_index` ON `artifacts` (`id`) WHERE "artifacts"."deletion_error" is not null;--> statement-breakpoint
CREATE INDEX `jobs_pending_cleanup_index` ON `jobs` (`state`,`id`) WHERE "jobs"."workspace_cleaned_at" is null;--> statement-breakpoint
CREATE INDEX `prepared_sources_pending_cleanup_index` ON `prepared_sources` (`state`,`id`) WHERE "prepared_sources"."cleaned_at" is null;--> statement-breakpoint
CREATE INDEX `source_write_activities_source_index` ON `source_write_activities` (`source_id`);