ALTER TABLE `source_object_uploads` ADD `membership_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `source_object_uploads` ADD `worker_pid` integer;--> statement-breakpoint
ALTER TABLE `source_object_uploads` ADD `worker_identity` text;--> statement-breakpoint
ALTER TABLE `source_object_uploads` ADD `lease_owner` text;--> statement-breakpoint
ALTER TABLE `source_object_uploads` ADD `next_attempt_at` integer DEFAULT 0 NOT NULL;