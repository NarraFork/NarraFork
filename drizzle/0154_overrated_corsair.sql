ALTER TABLE `narrator_tool_calls` ADD `execution_attempt` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `narrator_tool_calls` ADD `file_change_operation_id` text REFERENCES file_change_operations(id);--> statement-breakpoint
CREATE INDEX `idx_toolcalls_attempt` ON `narrator_tool_calls` (`narrator_id`,`tool_use_id`,`message_id`,`execution_attempt`);--> statement-breakpoint
CREATE INDEX `idx_toolcalls_file_change_operation` ON `narrator_tool_calls` (`file_change_operation_id`);