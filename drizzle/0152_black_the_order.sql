DROP INDEX `idx_fc_reservation_budget`;--> statement-breakpoint
ALTER TABLE `file_change_blob_reservations` ADD `generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_fc_reservation_budget` ON `file_change_blob_reservations` (`budget_id`,`status`,`created_at`,`id`);--> statement-breakpoint
ALTER TABLE `file_change_effects` ADD `execution_receipt_json` text;--> statement-breakpoint
ALTER TABLE `file_change_effects` ADD `execution_receipt_digest` text;--> statement-breakpoint
ALTER TABLE `file_change_operations` ADD `prepared_effect_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `file_change_operations` ADD `evidence_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `file_change_operations` ADD `settled_effect_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `file_change_operations` ADD `unresolved_effect_count` integer DEFAULT 0 NOT NULL;