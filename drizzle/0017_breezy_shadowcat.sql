CREATE TABLE `narrator_buffered_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`narrator_id` text NOT NULL,
	`text` text NOT NULL,
	`images_json` text,
	`command_text` text,
	`created_by` text,
	`creator_json` text,
	`text_file_paths_json` text,
	`seq` integer NOT NULL,
	`buffered_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_nbm_narrator_seq` ON `narrator_buffered_messages` (`narrator_id`,`seq`);