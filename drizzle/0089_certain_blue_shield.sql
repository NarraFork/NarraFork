CREATE TABLE `narrator_message_render_index_v2` (
	`narrator_id` text NOT NULL,
	`message_id` text NOT NULL,
	`render_revision` integer DEFAULT 0 NOT NULL,
	`outline_json` text NOT NULL,
	`preview_json` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`narrator_id`, `message_id`),
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `narrator_messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_message_render_index_v2_message` ON `narrator_message_render_index_v2` (`message_id`);