DROP INDEX `idx_narrator_refs_delivery`;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_narrator_refs_delivery` ON `narrator_message_refs` (`narrator_id`,`delivery_id`);