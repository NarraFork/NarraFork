PRAGMA foreign_keys=OFF;
--> statement-breakpoint
ALTER TABLE `scheduled_task_runs` ADD `logical_run_id` text;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `schedule_revision` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `schedule_cursor_at` text;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `active_run_id` text;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
