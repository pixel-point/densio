CREATE TABLE `hls_access_grants` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`video_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`revision` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_hls_access_grants_organization_id_video_id_videos_organization_id_id_fk` FOREIGN KEY (`organization_id`,`video_id`) REFERENCES `videos`(`organization_id`,`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hls_access_grants_token` ON `hls_access_grants` (`token_hash`);--> statement-breakpoint
CREATE INDEX `hls_access_grants_expiry` ON `hls_access_grants` (`expires_at`);