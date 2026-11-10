PRAGMA foreign_keys=OFF;
--> statement-breakpoint
ALTER TABLE `narrators` ADD `workspace_directories` text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
