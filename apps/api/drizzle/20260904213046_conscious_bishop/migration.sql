ALTER TABLE `storage_objects` ADD `package_member_id` text;--> statement-breakpoint
ALTER TABLE `videos` ADD `hls_package_id` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_storage_objects` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`video_id` text,
	`variant_id` text,
	`package_member_id` text,
	`transfer_id` text,
	`connection_id` text,
	`target_id` text NOT NULL,
	`bucket_role` text NOT NULL,
	`bucket` text NOT NULL,
	`object_key` text NOT NULL,
	`version_id` text,
	`state` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`upload_id` text,
	`parts_json` text DEFAULT '[]' NOT NULL,
	`etag` text,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`public_url` text,
	`purge_after` integer,
	`purged_at` integer,
	`created_at` integer NOT NULL,
	`verified_at` integer,
	`health_check_after` integer DEFAULT 0 NOT NULL,
	`health_error_code` text,
	`deleted_at` integer,
	CONSTRAINT `fk_storage_objects_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`),
	CONSTRAINT `fk_storage_objects_organization_id_package_member_id_video_package_members_organization_id_id_fk` FOREIGN KEY (`organization_id`,`package_member_id`) REFERENCES `video_package_members`(`organization_id`,`id`),
	CONSTRAINT `fk_storage_objects_organization_id_variant_id_video_variants_organization_id_id_fk` FOREIGN KEY (`organization_id`,`variant_id`) REFERENCES `video_variants`(`organization_id`,`id`)
);
--> statement-breakpoint
INSERT INTO `__new_storage_objects`(`id`, `organization_id`, `video_id`, `variant_id`, `transfer_id`, `connection_id`, `target_id`, `bucket_role`, `bucket`, `object_key`, `version_id`, `state`, `revision`, `upload_id`, `parts_json`, `etag`, `bytes`, `sha256`, `public_url`, `purge_after`, `purged_at`, `created_at`, `verified_at`, `health_check_after`, `health_error_code`, `deleted_at`) SELECT `id`, `organization_id`, `video_id`, `variant_id`, `transfer_id`, `connection_id`, `target_id`, `bucket_role`, `bucket`, `object_key`, `version_id`, `state`, `revision`, `upload_id`, `parts_json`, `etag`, `bytes`, `sha256`, `public_url`, `purge_after`, `purged_at`, `created_at`, `verified_at`, `health_check_after`, `health_error_code`, `deleted_at` FROM `storage_objects`;--> statement-breakpoint
DROP TABLE `storage_objects`;--> statement-breakpoint
ALTER TABLE `__new_storage_objects` RENAME TO `storage_objects`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `storage_objects_locator` ON `storage_objects` (`target_id`,`bucket`,`object_key`);--> statement-breakpoint
CREATE INDEX `storage_objects_video` ON `storage_objects` (`organization_id`,`video_id`);