ALTER TABLE `background_tasks` ADD `tool_call_id` text;--> statement-breakpoint
ALTER TABLE `background_tasks` ADD `execution_attempt` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_bg_tasks_tool_attempt` ON `background_tasks` (`tool_call_id`,`execution_attempt`);