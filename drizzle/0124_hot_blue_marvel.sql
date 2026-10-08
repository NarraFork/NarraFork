CREATE TABLE `chat_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`seq` integer NOT NULL,
	`sender_user_id` text,
	`kind` text DEFAULT 'text' NOT NULL,
	`content_text` text NOT NULL,
	`reply_to_message_id` text,
	`edited_at` text,
	`deleted_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `chat_rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sender_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_chat_messages_room_seq` ON `chat_messages` (`room_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_chat_messages_sender` ON `chat_messages` (`sender_user_id`);--> statement-breakpoint
CREATE TABLE `chat_room_members` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`user_id` text NOT NULL,
	`last_read_seq` integer DEFAULT 0 NOT NULL,
	`last_read_at` text,
	`muted` integer DEFAULT false NOT NULL,
	`joined_at` text NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `chat_rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_chat_room_members_room_user` ON `chat_room_members` (`room_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `idx_chat_room_members_user_room` ON `chat_room_members` (`user_id`,`room_id`);--> statement-breakpoint
CREATE TABLE `chat_rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`dm_key` text,
	`narrator_id` text,
	`next_seq` integer DEFAULT 1 NOT NULL,
	`last_message_at` text,
	`last_message_preview` text,
	`last_message_sender_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_chat_rooms_dm_key` ON `chat_rooms` (`dm_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_chat_rooms_narrator` ON `chat_rooms` (`narrator_id`);--> statement-breakpoint
CREATE INDEX `idx_chat_rooms_kind_last` ON `chat_rooms` (`kind`,`last_message_at`);