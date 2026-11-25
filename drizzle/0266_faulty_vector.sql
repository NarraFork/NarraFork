PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `executor_session_cleanups` (
	`device_id` text NOT NULL,
	`session_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`device_id`, `session_id`)
);
--> statement-breakpoint
ALTER TABLE `terminals` ADD `executor_session_id` text;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
