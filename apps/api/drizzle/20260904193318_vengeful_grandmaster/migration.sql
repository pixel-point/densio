ALTER TABLE `storage_objects` ADD `health_check_after` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `storage_objects` ADD `health_error_code` text;