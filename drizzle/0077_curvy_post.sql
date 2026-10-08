DROP INDEX `idx_narrators_handle`;--> statement-breakpoint
ALTER TABLE `narrators` ADD `handle_fold` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_narrators_handle_fold` ON `narrators` (`handle_fold`);--> statement-breakpoint
CREATE INDEX `idx_narrators_handle` ON `narrators` (`handle`);