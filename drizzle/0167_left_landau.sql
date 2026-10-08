ALTER TABLE `narrator_buffered_messages` ADD `current_revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `current_adopted_revision` integer;--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `current_adopted_at` text;--> statement-breakpoint
CREATE INDEX `idx_nbm_reserved` ON `narrator_buffered_messages` (`narrator_id`,`recipient_message_id`);