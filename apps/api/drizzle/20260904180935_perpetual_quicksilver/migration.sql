CREATE TABLE `managed_inventory_scans` (
	`id` text PRIMARY KEY,
	`target_id` text NOT NULL,
	`bucket_role` text NOT NULL,
	`bucket` text NOT NULL,
	`cursor` text,
	`started_at` integer,
	`next_run_at` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `managed_storage_orphans` (
	`id` text PRIMARY KEY,
	`target_id` text NOT NULL,
	`bucket_role` text NOT NULL,
	`bucket` text NOT NULL,
	`object_key` text NOT NULL,
	`bytes` integer NOT NULL,
	`etag` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `managed_storage_orphans_locator` ON `managed_storage_orphans` (`target_id`,`bucket`,`object_key`);