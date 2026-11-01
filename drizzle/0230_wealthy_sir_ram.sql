PRAGMA foreign_keys=OFF;
--> statement-breakpoint
ALTER TABLE `narrators` ADD `hidden_from_lists` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `narrators` ADD `modeltrace_key` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_narrators_modeltrace_key` ON `narrators` (`modeltrace_key`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
