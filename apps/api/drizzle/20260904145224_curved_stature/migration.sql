CREATE TABLE `billing_reconciliations` (
	`subscription_id` text PRIMARY KEY,
	`claim_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `source_write_activities` (
	`id` text PRIMARY KEY,
	`source_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`process_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_source_write_activities_source_id_prepared_sources_id_fk` FOREIGN KEY (`source_id`) REFERENCES `prepared_sources`(`id`),
	CONSTRAINT `fk_source_write_activities_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`)
);
--> statement-breakpoint
CREATE INDEX `source_write_activities_org_index` ON `source_write_activities` (`organization_id`);