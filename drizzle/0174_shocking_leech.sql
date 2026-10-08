ALTER TABLE `narrator_message_refs` ADD `delivery_id` text;--> statement-breakpoint
ALTER TABLE `narrator_message_refs` ADD `delivery_kind` text;--> statement-breakpoint
ALTER TABLE `narrator_message_refs` ADD `delivery_state` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_narrator_refs_delivery` ON `narrator_message_refs` (`delivery_id`);--> statement-breakpoint
CREATE INDEX `idx_narrator_refs_delivery_state` ON `narrator_message_refs` (`narrator_id`,`delivery_state`,`seq`);