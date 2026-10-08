DROP TABLE `overseers`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_narrator_tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`narrator_id` text NOT NULL,
	`message_id` text NOT NULL,
	`tool_use_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`input_json` text,
	`output_json` text,
	`status` text DEFAULT 'initializing' NOT NULL,
	`duration_ms` integer,
	`error_message` text,
	`permission_decided_by` text,
	`permission_decided_at` text,
	`permission_deny_message` text,
	`permission_decision_reason` text,
	`permission_suggestions` text,
	`is_background` integer DEFAULT false NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_creation_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_creation_5m_tokens` integer DEFAULT 0 NOT NULL,
	`cache_creation_1h_tokens` integer DEFAULT 0 NOT NULL,
	`input_cost` real DEFAULT 0 NOT NULL,
	`output_cost` real DEFAULT 0 NOT NULL,
	`cache_creation_cost` real DEFAULT 0 NOT NULL,
	`cache_read_cost` real DEFAULT 0 NOT NULL,
	`total_cost` real DEFAULT 0 NOT NULL,
	`provider` text,
	`model` text,
	`result_message_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `narrator_messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_narrator_tool_calls`("id", "narrator_id", "message_id", "tool_use_id", "tool_name", "input_json", "output_json", "status", "duration_ms", "error_message", "permission_decided_by", "permission_decided_at", "permission_deny_message", "permission_decision_reason", "permission_suggestions", "is_background", "input_tokens", "output_tokens", "cache_creation_tokens", "cache_read_tokens", "cache_creation_5m_tokens", "cache_creation_1h_tokens", "input_cost", "output_cost", "cache_creation_cost", "cache_read_cost", "total_cost", "provider", "model", "result_message_id", "created_at") SELECT "id", "narrator_id", "message_id", "tool_use_id", "tool_name", "input_json", "output_json", "status", "duration_ms", "error_message", "permission_decided_by", "permission_decided_at", "permission_deny_message", "permission_decision_reason", "permission_suggestions", "is_background", "input_tokens", "output_tokens", "cache_creation_tokens", "cache_read_tokens", "cache_creation_5m_tokens", "cache_creation_1h_tokens", "input_cost", "output_cost", "cache_creation_cost", "cache_read_cost", "total_cost", "provider", "model", "result_message_id", "created_at" FROM `narrator_tool_calls`;--> statement-breakpoint
DROP TABLE `narrator_tool_calls`;--> statement-breakpoint
ALTER TABLE `__new_narrator_tool_calls` RENAME TO `narrator_tool_calls`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_toolcalls_message` ON `narrator_tool_calls` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_toolcalls_tool_use_id` ON `narrator_tool_calls` (`tool_use_id`);--> statement-breakpoint
CREATE INDEX `idx_toolcalls_status` ON `narrator_tool_calls` (`narrator_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_toolcalls_created` ON `narrator_tool_calls` (`narrator_id`,`created_at`);