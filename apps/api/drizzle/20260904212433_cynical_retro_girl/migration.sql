CREATE TABLE `hls_packages` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`job_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`directory` text NOT NULL,
	`inventory_json` text NOT NULL,
	`package_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_hls_packages_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`),
	CONSTRAINT `fk_hls_packages_job_id_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`),
	CONSTRAINT `fk_hls_packages_artifact_id_artifacts_id_fk` FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hls_packages_job` ON `hls_packages` (`job_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `hls_packages_artifact` ON `hls_packages` (`artifact_id`);