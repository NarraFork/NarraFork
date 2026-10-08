CREATE TABLE `narrator_public_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`narrator_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`guest_name` text NOT NULL,
	`label` text,
	`created_by_user_id` text,
	`created_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_narrator_public_shares_token_hash` ON `narrator_public_shares` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_narrator_public_shares_narrator_created` ON `narrator_public_shares` (`narrator_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_narrator_public_shares_created_by` ON `narrator_public_shares` (`created_by_user_id`);--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `sender_share_id` text REFERENCES narrator_public_shares(id);--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `sender_guest_name` text;--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `reply_to_guest_name` text;--> statement-breakpoint
CREATE INDEX `idx_chat_messages_sender_share` ON `chat_messages` (`sender_share_id`);