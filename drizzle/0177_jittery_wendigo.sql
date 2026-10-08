CREATE TABLE `file_change_scope_recoveries` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_id` text NOT NULL,
	`device_id` text NOT NULL,
	`canonical_root` text NOT NULL,
	`path_flavor` text NOT NULL,
	`recovered_by_user_id` text,
	`effect_decisions_json` text NOT NULL,
	`scope_revision_before` integer NOT NULL,
	`fencing_token_before` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`scope_id`) REFERENCES `file_change_scopes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recovered_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_fc_scope_recovery_scope` ON `file_change_scope_recoveries` (`scope_id`,`created_at`);--> statement-breakpoint
DROP INDEX `idx_narrator_refs_delivery`;--> statement-breakpoint
DROP INDEX `idx_narrator_refs_delivery_state`;--> statement-breakpoint
ALTER TABLE `narrator_message_refs` DROP COLUMN `delivery_id`;--> statement-breakpoint
ALTER TABLE `narrator_message_refs` DROP COLUMN `delivery_kind`;--> statement-breakpoint
ALTER TABLE `narrator_message_refs` DROP COLUMN `delivery_state`;