PRAGMA foreign_keys=OFF;
--> statement-breakpoint
ALTER TABLE `narrators` ADD `ask_in_passing_group_id` text REFERENCES narrators(id) ON UPDATE no action ON DELETE set null;
--> statement-breakpoint
ALTER TABLE `narrators` ADD `archived_with_narrator_id` text REFERENCES narrators(id) ON UPDATE no action ON DELETE set null;
--> statement-breakpoint
CREATE INDEX `idx_narrators_ask_in_passing_group` ON `narrators` (`ask_in_passing_group_id`);
--> statement-breakpoint
CREATE INDEX `idx_narrators_archived_with` ON `narrators` (`archived_with_narrator_id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
