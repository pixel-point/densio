CREATE TABLE `billing_checkout_attempts` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`plan` text NOT NULL,
	`price_id` text NOT NULL,
	`cancel_url` text NOT NULL,
	`success_url` text NOT NULL,
	`state` text NOT NULL,
	`session_id` text,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_billing_checkout_attempts_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`)
);
--> statement-breakpoint
CREATE TABLE `billing_customer_requests` (
	`organization_id` text PRIMARY KEY,
	`billing_email` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_billing_customer_requests_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`)
);
--> statement-breakpoint
CREATE TABLE `billing_operations` (
	`organization_id` text PRIMARY KEY,
	`id` text NOT NULL,
	`operation` text NOT NULL,
	`request_key` text NOT NULL,
	`lease_token` text NOT NULL,
	`lease_expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_billing_operations_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_checkout_attempts_org_key_unique` ON `billing_checkout_attempts` (`organization_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `billing_checkout_attempts_live_unique` ON `billing_checkout_attempts` (`organization_id`) WHERE "billing_checkout_attempts"."state" in ('creating','open');