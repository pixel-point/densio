CREATE TABLE `source_object_uploads` (
	`source_id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`object_id` text NOT NULL,
	`state` text NOT NULL,
	`declared_bytes` integer NOT NULL,
	`part_size` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`error_code` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_source_object_uploads_object_id_storage_objects_id_fk` FOREIGN KEY (`object_id`) REFERENCES `storage_objects`(`id`),
	CONSTRAINT `fk_source_object_uploads_organization_id_connection_id_storage_connections_organization_id_id_fk` FOREIGN KEY (`organization_id`,`connection_id`) REFERENCES `storage_connections`(`organization_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `storage_connection_operations` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`candidate_ciphertext` text,
	`credential_version` integer,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`progress_json` text DEFAULT '{}' NOT NULL,
	`error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_storage_connection_operations_organization_id_connection_id_storage_connections_organization_id_id_fk` FOREIGN KEY (`organization_id`,`connection_id`) REFERENCES `storage_connections`(`organization_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `storage_connections` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`config_json` text NOT NULL,
	`credentials_ciphertext` text,
	`credential_version` integer DEFAULT 1 NOT NULL,
	`encryption_key_version` text DEFAULT 'primary' NOT NULL,
	`state` text NOT NULL,
	`error_code` text,
	`validated_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	CONSTRAINT `fk_storage_connections_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`)
);
--> statement-breakpoint
CREATE TABLE `storage_objects` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`video_id` text,
	`variant_id` text,
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
	`deleted_at` integer,
	CONSTRAINT `fk_storage_objects_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`),
	CONSTRAINT `fk_storage_objects_organization_id_variant_id_video_variants_organization_id_id_fk` FOREIGN KEY (`organization_id`,`variant_id`) REFERENCES `video_variants`(`organization_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `storage_settings` (
	`organization_id` text PRIMARY KEY,
	`destination_json` text DEFAULT '{"kind":"temporary"}' NOT NULL,
	`visibility` text DEFAULT 'public' NOT NULL,
	`policy_revision` integer DEFAULT 0 NOT NULL,
	`grace_deadline` integer,
	`effective_limit` integer DEFAULT 0 NOT NULL,
	`notified_json` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_storage_settings_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`)
);
--> statement-breakpoint
CREATE TABLE `storage_transfers` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`video_id` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`worker_pid` integer,
	`worker_identity` text,
	`lease_owner` text,
	`next_attempt_at` integer NOT NULL,
	`recovery_deadline` integer NOT NULL,
	`intent_json` text NOT NULL,
	`progress_json` text DEFAULT '{}' NOT NULL,
	`error_code` text,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_storage_transfers_organization_id_video_id_videos_organization_id_id_fk` FOREIGN KEY (`organization_id`,`video_id`) REFERENCES `videos`(`organization_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `video_access_grants` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`variant_id` text NOT NULL,
	`membership_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_video_access_grants_organization_id_variant_id_video_variants_organization_id_id_fk` FOREIGN KEY (`organization_id`,`variant_id`) REFERENCES `video_variants`(`organization_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `video_variants` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`video_id` text NOT NULL,
	`artifact_id` text,
	`filename` text NOT NULL,
	`codec` text NOT NULL,
	`media_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`width` integer,
	`height` integer,
	`duration_seconds` real,
	`input_path` text,
	`input_expires_at` integer NOT NULL,
	`active_object_id` text,
	`public_key` text NOT NULL,
	CONSTRAINT `fk_video_variants_organization_id_video_id_videos_organization_id_id_fk` FOREIGN KEY (`organization_id`,`video_id`) REFERENCES `videos`(`organization_id`,`id`)
);
--> statement-breakpoint
CREATE TABLE `videos` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`job_id` text NOT NULL,
	`automatic_job_id` text,
	`display_name` text NOT NULL,
	`filename_stem` text NOT NULL,
	`destination_json` text NOT NULL,
	`target_id` text NOT NULL,
	`connection_id` text,
	`public_origin` text,
	`visibility` text NOT NULL,
	`visibility_revision` integer DEFAULT 0 NOT NULL,
	`state` text NOT NULL,
	`transfer_id` text NOT NULL,
	`total_bytes` integer NOT NULL,
	`capacity_state` text DEFAULT 'none' NOT NULL,
	`error_code` text,
	`created_at` integer NOT NULL,
	`stored_at` integer,
	`deleted_at` integer,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	CONSTRAINT `fk_videos_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`),
	CONSTRAINT `fk_videos_organization_id_connection_id_storage_connections_organization_id_id_fk` FOREIGN KEY (`organization_id`,`connection_id`) REFERENCES `storage_connections`(`organization_id`,`id`),
	CONSTRAINT "videos_total_bytes_positive" CHECK("total_bytes" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `storage_connection_operations_key` ON `storage_connection_operations` (`organization_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `storage_connections_org_key` ON `storage_connections` (`organization_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `storage_connections_org_id` ON `storage_connections` (`organization_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `storage_objects_locator` ON `storage_objects` (`target_id`,`bucket`,`object_key`);--> statement-breakpoint
CREATE INDEX `storage_objects_video` ON `storage_objects` (`organization_id`,`video_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `storage_transfers_org_key` ON `storage_transfers` (`organization_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `storage_transfers_pending` ON `storage_transfers` (`state`,`next_attempt_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `video_access_grants_token` ON `video_access_grants` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `video_variants_org_id` ON `video_variants` (`organization_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `video_variants_codec` ON `video_variants` (`video_id`,`codec`);--> statement-breakpoint
CREATE UNIQUE INDEX `videos_org_id` ON `videos` (`organization_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `videos_org_key` ON `videos` (`organization_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `videos_automatic_job` ON `videos` (`automatic_job_id`);--> statement-breakpoint
CREATE INDEX `videos_org_created` ON `videos` (`organization_id`,`created_at`,`id`);