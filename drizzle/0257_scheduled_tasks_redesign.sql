PRAGMA foreign_keys=OFF;
--> statement-breakpoint
ALTER TABLE `scheduled_task_runs` ADD `error_kind` text;
--> statement-breakpoint
ALTER TABLE `scheduled_task_runs` ADD `scheduled_for` text;
--> statement-breakpoint
ALTER TABLE `scheduled_task_runs` ADD `trigger` text DEFAULT 'schedule' NOT NULL;
--> statement-breakpoint
ALTER TABLE `scheduled_task_runs` ADD `trigger_message_id` text;
--> statement-breakpoint
ALTER TABLE `scheduled_task_runs` ADD `logical_run_id` text;
--> statement-breakpoint
ALTER TABLE `scheduled_task_runs` ADD `model` text;
--> statement-breakpoint
ALTER TABLE `scheduled_task_runs` ADD `block_reason` text;
--> statement-breakpoint
ALTER TABLE `scheduled_task_runs` ADD `blocked_at` text;
--> statement-breakpoint
ALTER TABLE `scheduled_task_runs` ADD `outcome` text;
--> statement-breakpoint
ALTER TABLE `scheduled_task_runs` ADD `outcome_summary` text;
--> statement-breakpoint
ALTER TABLE `scheduled_task_runs` ADD `outcome_reported_at` text;
--> statement-breakpoint
ALTER TABLE `scheduled_task_runs` ADD `auto_handled` text;
--> statement-breakpoint
ALTER TABLE `scheduled_task_runs` ADD `require_report` integer DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE `scheduled_task_runs` ADD `busy_deadline_at` text;
--> statement-breakpoint
ALTER TABLE `scheduled_task_runs` ADD `interrupt_target` text;
--> statement-breakpoint
ALTER TABLE `scheduled_task_runs` ADD `nudged` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `scheduled_task_runs` ADD `missed_count` integer;
--> statement-breakpoint
ALTER TABLE `scheduled_task_runs` ADD `deadline_at` text;
--> statement-breakpoint
ALTER TABLE `scheduled_task_runs` ADD `stats` text;
--> statement-breakpoint
CREATE INDEX `idx_scheduled_task_runs_task_status` ON `scheduled_task_runs` (`task_id`,`status`);
--> statement-breakpoint
CREATE INDEX `idx_scheduled_task_runs_narrator_task` ON `scheduled_task_runs` (`narrator_id`,`task_id`);
--> statement-breakpoint
CREATE INDEX `idx_scheduled_task_runs_wait_queue` ON `scheduled_task_runs` (`narrator_id`,`status`,`created_at`,`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_scheduled_task_runs_one_waiting` ON `scheduled_task_runs` (`task_id`) WHERE "scheduled_task_runs"."status" = 'waiting';
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_scheduled_task_runs_one_interrupt` ON `scheduled_task_runs` (`narrator_id`) WHERE "scheduled_task_runs"."status" = 'waiting' AND "scheduled_task_runs"."interrupt_target" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_scheduled_task_runs_status` ON `scheduled_task_runs` (`status`,`created_at`);
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `schedule` text;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `schedule_kind` text;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `fired_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `schedule_revision` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `schedule_cursor_at` text;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `active_run_id` text;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `completed_at` text;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `pause_reason` text;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `consecutive_failures` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `target_narrator_id` text REFERENCES narrators(id) ON UPDATE no action ON DELETE set null;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `context_policy` text DEFAULT 'keep' NOT NULL;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `on_busy` text DEFAULT 'skip' NOT NULL;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `busy_wait_minutes` integer DEFAULT 30 NOT NULL;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `require_report` integer DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `model_policy` text DEFAULT 'follow' NOT NULL;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `on_blocked` text DEFAULT 'auto' NOT NULL;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `blocked_wait_minutes` integer DEFAULT 30 NOT NULL;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `max_run_minutes` integer DEFAULT 60 NOT NULL;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `notify_on_success` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `owner_user_id` text REFERENCES users(id) ON UPDATE no action ON DELETE set null;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `creator_kind` text DEFAULT 'user' NOT NULL;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `creator_narrator_id` text;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `creator_message_id` text;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `creator_tool_call_id` text;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `creator_tool_use_id` text;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `creator_snapshot` text;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `last_modified_by` text;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `last_run_id` text;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `last_outcome` text;
--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `last_summary` text;
--> statement-breakpoint
CREATE INDEX `idx_scheduled_tasks_owner` ON `scheduled_tasks` (`owner_user_id`);
--> statement-breakpoint
CREATE INDEX `idx_scheduled_tasks_target_narrator` ON `scheduled_tasks` (`target_narrator_id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
