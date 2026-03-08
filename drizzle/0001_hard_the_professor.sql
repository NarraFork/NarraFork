CREATE TABLE `narrator_whitelist_dirs` (
	`id` text PRIMARY KEY NOT NULL,
	`narrator_id` text NOT NULL,
	`path` text NOT NULL,
	`access_level` text DEFAULT 'readOnly' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_whitelist_dirs_narrator` ON `narrator_whitelist_dirs` (`narrator_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_whitelist_dirs_narrator_path` ON `narrator_whitelist_dirs` (`narrator_id`,`path`);--> statement-breakpoint
ALTER TABLE `narrators` ADD `fast_mode` integer DEFAULT false NOT NULL;