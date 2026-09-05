CREATE TABLE `video_package_members` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`video_id` text NOT NULL,
	`artifact_id` text,
	`filename` text NOT NULL,
	`role` text NOT NULL,
	`media_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`input_object_id` text,
	`input_path` text,
	`input_expires_at` integer NOT NULL,
	`active_object_id` text,
	`public_key` text NOT NULL,
	CONSTRAINT `fk_video_package_members_organization_id_video_id_videos_organization_id_id_fk` FOREIGN KEY (`organization_id`,`video_id`) REFERENCES `videos`(`organization_id`,`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `video_package_members_org_id` ON `video_package_members` (`organization_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `video_package_members_path` ON `video_package_members` (`video_id`,`filename`);--> statement-breakpoint
CREATE INDEX `video_package_members_input` ON `video_package_members` (`input_object_id`);