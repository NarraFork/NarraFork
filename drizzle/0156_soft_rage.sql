ALTER TABLE `narrator_buffered_messages` ADD `file_references_json` text;--> statement-breakpoint
ALTER TABLE `narrator_drafts` ADD `file_references_json` text;--> statement-breakpoint
ALTER TABLE `narrators` ADD `origin_tool_call_id` text;