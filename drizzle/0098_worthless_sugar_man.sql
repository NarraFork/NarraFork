ALTER TABLE `narrator_file_snapshots` ADD `original_encoding` text;--> statement-breakpoint
ALTER TABLE `narrator_file_snapshots` ADD `is_binary` integer DEFAULT false NOT NULL;