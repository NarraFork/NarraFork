CREATE TABLE `chat_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`message_id` text,
	`uploader_user_id` text,
	`kind` text NOT NULL,
	`filename` text NOT NULL,
	`media_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`width` integer,
	`height` integer,
	`stored_name` text NOT NULL,
	`created_at` text NOT NULL,
	`claimed_at` text,
	FOREIGN KEY (`room_id`) REFERENCES `chat_rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploader_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_chat_attachments_message` ON `chat_attachments` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_chat_attachments_room_unclaimed` ON `chat_attachments` (`room_id`,`claimed_at`);--> statement-breakpoint
CREATE INDEX `idx_chat_attachments_uploader` ON `chat_attachments` (`uploader_user_id`);--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `reply_to_seq` integer;--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `reply_to_sender_user_id` text;--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `reply_to_preview` text;