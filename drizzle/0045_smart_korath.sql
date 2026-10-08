ALTER TABLE `narrators` ADD `handle` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_narrators_handle` ON `narrators` (`handle`);