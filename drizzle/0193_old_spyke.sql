PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `narrator_question_events` (
	`question_id` text NOT NULL,
	`message_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`resolution_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `narrator_questions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `narrator_messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_question_events_question_rowid` ON `narrator_question_events` (`question_id`);
--> statement-breakpoint
CREATE INDEX `idx_question_events_question_created` ON `narrator_question_events` (`question_id`,`created_at`,`message_id`);
--> statement-breakpoint
ALTER TABLE `api_requests` ADD `context_usage_snapshot_json` text;
--> statement-breakpoint
ALTER TABLE `narrator_questions` ADD `context` text;
--> statement-breakpoint
ALTER TABLE `narrator_questions` ADD `resolution_json` text;
--> statement-breakpoint
ALTER TABLE `narrator_questions` ADD `withdraw_reason` text;
--> statement-breakpoint
ALTER TABLE `narrator_questions` ADD `summary_json` text;
--> statement-breakpoint
CREATE INDEX `idx_narrator_questions_answer_message` ON `narrator_questions` (`answer_message_id`);
--> statement-breakpoint
CREATE INDEX `idx_narrator_questions_created` ON `narrator_questions` (`created_at`,`id`);
--> statement-breakpoint
ALTER TABLE `narrators` ADD `context_usage_snapshot_json` text;
--> statement-breakpoint
ALTER TABLE `narrators` ADD `last_stop_reason` text;
--> statement-breakpoint
CREATE INDEX `idx_toolcalls_context_id` ON `narrator_tool_calls` (`message_id`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_toolcalls_context_order` ON `narrator_tool_calls` (`message_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_toolcalls_context_latest` ON `narrator_tool_calls` (`message_id`,`tool_use_id`,`execution_attempt`,`created_at`,`id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
