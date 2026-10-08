CREATE TABLE `file_change_execution_segments` (
	`id` text PRIMARY KEY NOT NULL,
	`narrator_id` text NOT NULL,
	`parent_segment_id` text,
	`source_tool_call_id` text,
	`source_execution_attempt` integer,
	`source_input_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_fc_segment_source` ON `file_change_execution_segments` (`source_tool_call_id`,`source_execution_attempt`);--> statement-breakpoint
CREATE INDEX `idx_fc_segment_parent` ON `file_change_execution_segments` (`parent_segment_id`);--> statement-breakpoint
CREATE INDEX `idx_fc_segment_narrator` ON `file_change_execution_segments` (`narrator_id`);--> statement-breakpoint
CREATE TABLE `file_history_clock` (
	`id` integer PRIMARY KEY NOT NULL,
	`last_seq` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE `file_change_effects` ADD `journal_seq` integer;--> statement-breakpoint
ALTER TABLE `file_change_operations` ADD `journal_seq` integer;--> statement-breakpoint
ALTER TABLE `file_change_operations` ADD `execution_segment_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_fc_operation_sequence` ON `file_change_operations` (`journal_seq`);--> statement-breakpoint
CREATE INDEX `idx_fc_operation_segment` ON `file_change_operations` (`execution_segment_id`,`journal_seq`);--> statement-breakpoint
ALTER TABLE `narrator_tool_calls` ADD `execution_segment_id` text;