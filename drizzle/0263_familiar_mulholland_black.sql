PRAGMA foreign_keys=OFF;
--> statement-breakpoint
ALTER TABLE `user_recent_tabs` ADD `project_id` text;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
