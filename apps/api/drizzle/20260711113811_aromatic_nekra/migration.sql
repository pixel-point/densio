PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_email_outbox` (
	`id` text PRIMARY KEY,
	`challenge_id` text NOT NULL,
	`recipient` text NOT NULL,
	`confirmation_url` text,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	CONSTRAINT `fk_email_outbox_challenge_id_auth_challenges_id_fk` FOREIGN KEY (`challenge_id`) REFERENCES `auth_challenges`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_email_outbox`(`id`, `challenge_id`, `recipient`, `confirmation_url`, `status`, `attempts`, `next_attempt_at`, `last_error`, `created_at`, `sent_at`)
SELECT
	`id`,
	`challenge_id`,
	`recipient`,
	CASE WHEN `confirmation_url` LIKE 'v1.%' THEN `confirmation_url` ELSE NULL END,
	CASE WHEN `confirmation_url` LIKE 'v1.%' THEN `status` ELSE 'failed' END,
	`attempts`,
	CASE WHEN `confirmation_url` LIKE 'v1.%' THEN `next_attempt_at` ELSE 9007199254740991 END,
	CASE WHEN `confirmation_url` LIKE 'v1.%' THEN `last_error` ELSE 'legacy-unencrypted-secret' END,
	`created_at`,
	`sent_at`
FROM `email_outbox`;--> statement-breakpoint
DROP TABLE `email_outbox`;--> statement-breakpoint
ALTER TABLE `__new_email_outbox` RENAME TO `email_outbox`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `email_outbox_challenge_unique` ON `email_outbox` (`challenge_id`);--> statement-breakpoint
CREATE INDEX `email_outbox_pending_index` ON `email_outbox` (`status`,`next_attempt_at`);
