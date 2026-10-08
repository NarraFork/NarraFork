CREATE TABLE `file_change_blob_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`budget_id` text NOT NULL,
	`owner_epoch` text NOT NULL,
	`expected_size` integer NOT NULL,
	`status` text DEFAULT 'reserved' NOT NULL,
	`blob_digest` text,
	`published` integer,
	`created_at` text NOT NULL,
	`settled_at` text,
	FOREIGN KEY (`budget_id`) REFERENCES `file_change_storage_budgets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`blob_digest`) REFERENCES `file_change_blobs`(`digest`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_fc_reservation_budget` ON `file_change_blob_reservations` (`budget_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_fc_reservation_owner` ON `file_change_blob_reservations` (`owner_epoch`,`status`);--> statement-breakpoint
CREATE INDEX `idx_fc_reservation_blob` ON `file_change_blob_reservations` (`blob_digest`);--> statement-breakpoint
CREATE TABLE `file_change_storage_budgets` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_key` text NOT NULL,
	`status` text DEFAULT 'unverified' NOT NULL,
	`used_bytes` integer DEFAULT 0 NOT NULL,
	`reserved_bytes` integer DEFAULT 0 NOT NULL,
	`quota_bytes` integer NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`reconciled_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_fc_storage_namespace` ON `file_change_storage_budgets` (`namespace_key`);--> statement-breakpoint
ALTER TABLE `file_change_operations` ADD `request_digest` text;--> statement-breakpoint
ALTER TABLE `file_change_operations` ADD `expected_effect_count` integer;