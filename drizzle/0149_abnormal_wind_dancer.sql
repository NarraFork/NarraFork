CREATE TABLE `narrator_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`narrator_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`tool_use_id` text NOT NULL,
	`questions_json` text NOT NULL,
	`answers_json` text,
	`annotations_json` text,
	`status` text DEFAULT 'open' NOT NULL,
	`origin` text DEFAULT 'agent_async' NOT NULL,
	`answer_message_id` text,
	`decided_by` text,
	`decided_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tool_call_id`) REFERENCES `narrator_tool_calls`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_narrator_questions_tool_call` ON `narrator_questions` (`tool_call_id`);--> statement-breakpoint
CREATE INDEX `idx_narrator_questions_narrator_status` ON `narrator_questions` (`narrator_id`,`status`);