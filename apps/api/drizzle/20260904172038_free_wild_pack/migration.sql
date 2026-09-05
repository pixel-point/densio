CREATE TABLE `storage_requests` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`video_id` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_storage_requests_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`),
	CONSTRAINT `fk_storage_requests_organization_id_video_id_videos_organization_id_id_fk` FOREIGN KEY (`organization_id`,`video_id`) REFERENCES `videos`(`organization_id`,`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `storage_requests_org_key` ON `storage_requests` (`organization_id`,`idempotency_key`);