ALTER TABLE `narrators` ADD `subagent_origin_kind` text;--> statement-breakpoint
CREATE INDEX `idx_narrators_origin_tool_call` ON `narrators` (`origin_tool_call_id`);