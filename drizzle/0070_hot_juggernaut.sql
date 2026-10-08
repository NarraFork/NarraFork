CREATE TABLE `scheduled_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`cron_expr` text NOT NULL,
	`timezone` text,
	`prompt` text NOT NULL,
	`system_prompt` text,
	`model` text,
	`permission_mode` text DEFAULT 'bypassPermissions' NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`run_context` text DEFAULT 'standalone' NOT NULL,
	`cwd` text,
	`project_id` text,
	`chapter_id` text,
	`narrator_mode` text DEFAULT 'new' NOT NULL,
	`reuse_narrator_id` text,
	`created_by` text,
	`last_run_at` text,
	`next_run_at` text,
	`last_narrator_id` text,
	`last_status` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reuse_narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_scheduled_tasks_enabled` ON `scheduled_tasks` (`enabled`);--> statement-breakpoint
CREATE INDEX `idx_scheduled_tasks_next_run` ON `scheduled_tasks` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `idx_scheduled_tasks_project` ON `scheduled_tasks` (`project_id`);