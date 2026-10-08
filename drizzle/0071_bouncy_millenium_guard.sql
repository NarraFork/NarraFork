CREATE TABLE `scheduled_task_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`narrator_id` text,
	`status` text NOT NULL,
	`error` text,
	`run_context` text NOT NULL,
	`manual` integer DEFAULT false NOT NULL,
	`started_at` text,
	`finished_at` text,
	`duration_ms` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `scheduled_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_scheduled_task_runs_task` ON `scheduled_task_runs` (`task_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_scheduled_task_runs_narrator` ON `scheduled_task_runs` (`narrator_id`);