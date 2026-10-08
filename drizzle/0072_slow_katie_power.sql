DROP INDEX `idx_file_snapshots_narrator_file`;--> statement-breakpoint
ALTER TABLE `narrator_file_snapshots` ADD `device_id` text DEFAULT 'local' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_file_snapshots_device` ON `narrator_file_snapshots` (`device_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_file_snapshots_narrator_device_file` ON `narrator_file_snapshots` (`narrator_id`,`device_id`,`file_path`);--> statement-breakpoint
ALTER TABLE `file_attributions` ADD `device_id` text DEFAULT 'local' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_file_attr_device_workspace_file` ON `file_attributions` (`device_id`,`workspace_path`,`file_path`,`changed_at`);--> statement-breakpoint
ALTER TABLE `narrator_tool_calls` ADD `execution_device_id` text;--> statement-breakpoint
ALTER TABLE `narrator_tool_calls` ADD `execution_cwd` text;--> statement-breakpoint
ALTER TABLE `narrator_tool_calls` ADD `resolved_file_path` text;--> statement-breakpoint
ALTER TABLE `narrator_tool_calls` ADD `device_selection_source` text;--> statement-breakpoint
CREATE INDEX `idx_toolcalls_execution_device` ON `narrator_tool_calls` (`execution_device_id`,`created_at`);