ALTER TABLE `email_outbox` ADD `resource_key` text NOT NULL;--> statement-breakpoint
ALTER TABLE `email_outbox` ADD `payload_json` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_email_outbox` (
	`id` text PRIMARY KEY,
	`resource_key` text NOT NULL,
	`recipient` text NOT NULL,
	`payload_json` text,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`sent_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_email_outbox`(`id`, `recipient`, `status`, `attempts`, `next_attempt_at`, `last_error`, `created_at`, `sent_at`) SELECT `id`, `recipient`, `status`, `attempts`, `next_attempt_at`, `last_error`, `created_at`, `sent_at` FROM `email_outbox`;--> statement-breakpoint
DROP TABLE `email_outbox`;--> statement-breakpoint
ALTER TABLE `__new_email_outbox` RENAME TO `email_outbox`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
DROP INDEX IF EXISTS `email_outbox_challenge_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `email_outbox_resource_unique` ON `email_outbox` (`resource_key`);--> statement-breakpoint
CREATE INDEX `email_outbox_pending_index` ON `email_outbox` (`status`,`next_attempt_at`);