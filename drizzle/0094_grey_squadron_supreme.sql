CREATE INDEX `idx_chat_group_messages_sender_narrator` ON `chat_group_messages` (`sender_narrator_id`);--> statement-breakpoint
CREATE INDEX `idx_view_state_chapter` ON `terminal_view_state` (`chapter_id`);--> statement-breakpoint
CREATE INDEX `idx_view_state_narrator` ON `terminal_view_state` (`narrator_id`);