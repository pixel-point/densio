CREATE TABLE `storage_object_reads` (
	`id` text PRIMARY KEY,
	`object_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`worker_pid` integer NOT NULL,
	`worker_identity` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_storage_object_reads_object_id_storage_objects_id_fk` FOREIGN KEY (`object_id`) REFERENCES `storage_objects`(`id`),
	CONSTRAINT `fk_storage_object_reads_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`)
);
--> statement-breakpoint
CREATE INDEX `storage_object_reads_object` ON `storage_object_reads` (`object_id`);