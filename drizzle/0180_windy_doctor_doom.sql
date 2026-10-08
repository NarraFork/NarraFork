CREATE TABLE `user_usage_totals` (
	`user_id` text PRIMARY KEY NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cached_input_tokens` integer DEFAULT 0 NOT NULL,
	`cache_creation_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`unpriced_request_count` integer DEFAULT 0 NOT NULL,
	`first_used_at` text NOT NULL,
	`last_used_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `api_requests` ADD `user_id` text;--> statement-breakpoint
CREATE INDEX `idx_api_requests_user_created` ON `api_requests` (`user_id`,`created_at`,`id`);