PRAGMA foreign_keys=OFF;
--> statement-breakpoint
ALTER TABLE `background_tasks` ADD `executor_session_json` text;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
