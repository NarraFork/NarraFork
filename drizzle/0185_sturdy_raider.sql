ALTER TABLE `narrators` ADD `scheduled_task_id` text REFERENCES scheduled_tasks(id);--> statement-breakpoint
CREATE INDEX `idx_narrators_scheduled_task_created` ON `narrators` (`scheduled_task_id`,`created_at`,`id`);--> statement-breakpoint
ALTER TABLE `scheduled_tasks` ADD `cleanup_policy` text DEFAULT '{"mode":"none"}' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_scheduled_tasks_last_narrator` ON `scheduled_tasks` (`last_narrator_id`);