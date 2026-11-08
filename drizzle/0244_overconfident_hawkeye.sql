PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `recent_tab_archive_marks` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`narrator_id` text NOT NULL,
	`folder_id` text,
	`archived_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_recent_tab_archive_mark` ON `recent_tab_archive_marks` (`user_id`,`narrator_id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
