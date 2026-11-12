PRAGMA foreign_keys=OFF;
--> statement-breakpoint
ALTER TABLE `narrators` ADD `task_backend` text DEFAULT 'spec' NOT NULL;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
