PRAGMA foreign_keys=OFF;
--> statement-breakpoint
ALTER TABLE `terminals` ADD `executor_session_id` text;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
