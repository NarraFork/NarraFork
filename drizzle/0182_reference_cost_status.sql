ALTER TABLE `api_requests` ADD `cost_status` text;--> statement-breakpoint
ALTER TABLE `api_requests` ADD `cost_missing_fields` text;--> statement-breakpoint
ALTER TABLE `credential_usage_totals` ADD `partial_request_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `narrator_messages` ADD `cost_status` text;--> statement-breakpoint
ALTER TABLE `narrator_messages` ADD `cost_missing_fields` text;--> statement-breakpoint
ALTER TABLE `narrator_tool_calls` ADD `cost_status` text;--> statement-breakpoint
ALTER TABLE `narrator_tool_calls` ADD `cost_missing_fields` text;--> statement-breakpoint
ALTER TABLE `user_usage_totals` ADD `partial_request_count` integer DEFAULT 0 NOT NULL;