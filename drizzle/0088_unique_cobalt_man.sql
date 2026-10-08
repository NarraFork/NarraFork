CREATE TABLE `narrator_message_render_index` (
	`message_id` text PRIMARY KEY NOT NULL,
	`render_revision` integer DEFAULT 0 NOT NULL,
	`outline_json` text NOT NULL,
	`preview_json` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `narrator_messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `narrators` ADD `message_structure_version` integer DEFAULT 0 NOT NULL;