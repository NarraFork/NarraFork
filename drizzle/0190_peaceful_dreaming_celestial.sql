CREATE TABLE `narrator_context_char_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`narrator_id` text NOT NULL,
	`generation` text NOT NULL,
	`page` integer NOT NULL,
	`segments_json` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `context_char_pages_generation_page_idx` ON `narrator_context_char_pages` (`narrator_id`,`generation`,`page`);--> statement-breakpoint
ALTER TABLE `narrator_messages` ADD `context_chars_json` text;--> statement-breakpoint
ALTER TABLE `narrator_tool_calls` ADD `input_chars` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `narrator_tool_calls` ADD `output_chars` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `narrators` ADD `context_summary_chars` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `narrators` ADD `context_system_chars` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `narrators` ADD `context_tools_chars` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `narrators` ADD `context_char_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `narrators` ADD `context_char_cache_json` text;