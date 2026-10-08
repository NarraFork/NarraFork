CREATE TABLE `background_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_narrator_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`command` text,
	`exit_code` integer,
	`subagent_narrator_id` text,
	`subagent_type` text,
	`tool_use_id` text,
	`alias` text,
	`title` text,
	`output` text,
	`output_bytes` integer DEFAULT 0 NOT NULL,
	`output_truncated` integer DEFAULT false NOT NULL,
	`notified` integer DEFAULT false NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`parent_narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`subagent_narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_bg_tasks_parent` ON `background_tasks` (`parent_narrator_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_bg_tasks_subagent` ON `background_tasks` (`subagent_narrator_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_benchmark_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`suite_id` text NOT NULL,
	`name` text NOT NULL,
	`model` text NOT NULL,
	`system_prompt` text,
	`permission_mode` text DEFAULT 'bypassPermissions',
	`status` text DEFAULT 'pending' NOT NULL,
	`config` text,
	`total_tasks` integer DEFAULT 0,
	`completed_tasks` integer DEFAULT 0,
	`passed_tasks` integer DEFAULT 0,
	`failed_tasks` integer DEFAULT 0,
	`total_cost_usd` real DEFAULT 0,
	`total_tokens_in` integer DEFAULT 0,
	`total_tokens_out` integer DEFAULT 0,
	`total_duration_ms` integer DEFAULT 0,
	`started_at` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`suite_id`) REFERENCES `benchmark_suites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_benchmark_runs`("id", "suite_id", "name", "model", "system_prompt", "permission_mode", "status", "config", "total_tasks", "completed_tasks", "passed_tasks", "failed_tasks", "total_cost_usd", "total_tokens_in", "total_tokens_out", "total_duration_ms", "started_at", "completed_at", "created_at") SELECT "id", "suite_id", "name", "model", "system_prompt", "permission_mode", "status", "config", "total_tasks", "completed_tasks", "passed_tasks", "failed_tasks", "total_cost_usd", "total_tokens_in", "total_tokens_out", "total_duration_ms", "started_at", "completed_at", "created_at" FROM `benchmark_runs`;--> statement-breakpoint
DROP TABLE `benchmark_runs`;--> statement-breakpoint
ALTER TABLE `__new_benchmark_runs` RENAME TO `benchmark_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;