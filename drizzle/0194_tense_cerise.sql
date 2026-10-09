PRAGMA foreign_keys=OFF;
--> statement-breakpoint
ALTER TABLE `background_tasks` ADD `background_kind` text DEFAULT 'task' NOT NULL;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
