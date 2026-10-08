CREATE INDEX `idx_chapter_commits_narrator_message` ON `chapter_commits` (`narrator_message_id`);--> statement-breakpoint
CREATE INDEX `idx_kie_trigger_message` ON `knowledge_injection_events` (`trigger_message_id`);--> statement-breakpoint
CREATE INDEX `idx_kie_trigger_tool_call` ON `knowledge_injection_events` (`trigger_tool_call_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_created_by` ON `narrator_messages` (`created_by`);--> statement-breakpoint
CREATE INDEX `idx_messages_edited_by` ON `narrator_messages` (`edited_by`);--> statement-breakpoint
CREATE INDEX `idx_narrators_fork_message` ON `narrators` (`fork_message_id`);--> statement-breakpoint
CREATE INDEX `idx_narrators_prune_boundary_message` ON `narrators` (`prune_boundary_message_id`);--> statement-breakpoint
CREATE INDEX `idx_spec_file_revisions_source_message` ON `spec_file_revisions` (`source_message_id`);