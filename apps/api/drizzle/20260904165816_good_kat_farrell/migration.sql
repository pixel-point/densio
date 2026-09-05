ALTER TABLE `storage_connection_operations` ADD `worker_pid` integer;--> statement-breakpoint
ALTER TABLE `storage_connection_operations` ADD `worker_identity` text;--> statement-breakpoint
ALTER TABLE `storage_connection_operations` ADD `lease_owner` text;