CREATE TABLE `benchmark_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`suite_id` text,
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
CREATE TABLE `benchmark_suites` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`version` text,
	`description` text,
	`tasks_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `benchmark_task_results` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`task_id` text NOT NULL,
	`task_name` text NOT NULL,
	`narrator_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`score` real,
	`max_score` real,
	`output` text,
	`eval_output` text,
	`error_message` text,
	`tokens_in` integer DEFAULT 0,
	`tokens_out` integer DEFAULT 0,
	`cost_usd` real DEFAULT 0,
	`duration_ms` integer DEFAULT 0,
	`tool_call_count` integer DEFAULT 0,
	`message_count` integer DEFAULT 0,
	`metadata` text,
	`started_at` text,
	`completed_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `benchmark_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_task_results_run` ON `benchmark_task_results` (`run_id`,`status`);