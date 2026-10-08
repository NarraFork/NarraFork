PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`seq` integer NOT NULL,
	`sender_user_id` text,
	`sender_share_id` text,
	`sender_guest_name` text,
	`kind` text DEFAULT 'text' NOT NULL,
	`content_text` text NOT NULL,
	`reply_to_message_id` text,
	`reply_to_seq` integer,
	`reply_to_sender_user_id` text,
	`reply_to_guest_name` text,
	`reply_to_preview` text,
	`edited_at` text,
	`deleted_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `chat_rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sender_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`sender_share_id`) REFERENCES `narrator_public_shares`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_chat_messages`("id", "room_id", "seq", "sender_user_id", "sender_share_id", "sender_guest_name", "kind", "content_text", "reply_to_message_id", "reply_to_seq", "reply_to_sender_user_id", "reply_to_guest_name", "reply_to_preview", "edited_at", "deleted_at", "created_at") SELECT "id", "room_id", "seq", "sender_user_id", "sender_share_id", "sender_guest_name", "kind", "content_text", "reply_to_message_id", "reply_to_seq", "reply_to_sender_user_id", "reply_to_guest_name", "reply_to_preview", "edited_at", "deleted_at", "created_at" FROM `chat_messages`;--> statement-breakpoint
DROP TABLE `chat_messages`;--> statement-breakpoint
ALTER TABLE `__new_chat_messages` RENAME TO `chat_messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_chat_messages_room_seq` ON `chat_messages` (`room_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_chat_messages_sender` ON `chat_messages` (`sender_user_id`);--> statement-breakpoint
CREATE INDEX `idx_chat_messages_sender_share` ON `chat_messages` (`sender_share_id`);