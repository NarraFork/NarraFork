ALTER TABLE `narrator_tool_calls` ADD `input_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `narrator_tool_calls` ADD `output_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `narrator_tool_calls` ADD `cache_creation_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `narrator_tool_calls` ADD `cache_read_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `narrator_tool_calls` ADD `cache_creation_5m_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `narrator_tool_calls` ADD `cache_creation_1h_tokens` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `narrator_tool_calls` ADD `input_cost` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `narrator_tool_calls` ADD `output_cost` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `narrator_tool_calls` ADD `cache_creation_cost` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `narrator_tool_calls` ADD `cache_read_cost` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `narrator_tool_calls` ADD `total_cost` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `narrator_tool_calls` ADD `provider` text;--> statement-breakpoint
ALTER TABLE `narrator_tool_calls` ADD `model` text;--> statement-breakpoint
CREATE INDEX `idx_toolcalls_created` ON `narrator_tool_calls` (`narrator_id`,`created_at`);