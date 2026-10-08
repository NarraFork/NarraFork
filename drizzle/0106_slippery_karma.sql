CREATE TABLE `credential_usage_totals` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`credential_id` text NOT NULL,
	`model` text NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cached_input_tokens` integer DEFAULT 0 NOT NULL,
	`cache_creation_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`unpriced_request_count` integer DEFAULT 0 NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_credential_usage_totals_key` ON `credential_usage_totals` (`provider`,`credential_id`,`model`);--> statement-breakpoint
CREATE INDEX `idx_credential_usage_totals_credential` ON `credential_usage_totals` (`provider`,`credential_id`);--> statement-breakpoint
CREATE INDEX `idx_credential_usage_totals_last_seen` ON `credential_usage_totals` (`last_seen_at`);--> statement-breakpoint
CREATE INDEX `idx_api_requests_credential` ON `api_requests` (`credential_id`,`created_at`);