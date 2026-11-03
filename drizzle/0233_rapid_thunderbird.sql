PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `usage_daily` (
	`id` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`billing_user_id` text NOT NULL,
	`project_id` text NOT NULL,
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
	`unpriced_request_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_usage_daily_key` ON `usage_daily` (`day`,`billing_user_id`,`project_id`,`provider`,`credential_id`,`model`);
--> statement-breakpoint
ALTER TABLE `api_requests` ADD `billing_user_id` text;
--> statement-breakpoint
ALTER TABLE `api_requests` ADD `project_id` text;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
