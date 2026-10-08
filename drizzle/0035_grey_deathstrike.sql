PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_api_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`narrator_id` text,
	`message_id` text,
	`kind` text DEFAULT 'narrator' NOT NULL,
	`provider` text,
	`credential_id` text,
	`model` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cached_input_tokens` integer DEFAULT 0 NOT NULL,
	`cache_creation_input_tokens` integer DEFAULT 0 NOT NULL,
	`cache_creation_5m_tokens` integer DEFAULT 0 NOT NULL,
	`cache_creation_1h_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`ttft_ms` integer,
	`duration_ms` integer,
	`cost_usd` real,
	`context_percent` real,
	`meter_usage` real,
	`meter_unit` text,
	`error_message` text,
	`raw_dump_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `narrator_messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_api_requests`("id", "narrator_id", "message_id", "kind", "provider", "credential_id", "model", "input_tokens", "output_tokens", "cached_input_tokens", "cache_creation_input_tokens", "cache_creation_5m_tokens", "cache_creation_1h_tokens", "reasoning_tokens", "ttft_ms", "duration_ms", "cost_usd", "context_percent", "meter_usage", "meter_unit", "error_message", "raw_dump_json", "created_at") SELECT "id", "narrator_id", "message_id", 'narrator', "provider", "credential_id", "model", "input_tokens", "output_tokens", "cached_input_tokens", "cache_creation_input_tokens", "cache_creation_5m_tokens", "cache_creation_1h_tokens", "reasoning_tokens", "ttft_ms", "duration_ms", "cost_usd", "context_percent", "meter_usage", "meter_unit", "error_message", "raw_dump_json", "created_at" FROM `api_requests`;--> statement-breakpoint
DROP TABLE `api_requests`;--> statement-breakpoint
ALTER TABLE `__new_api_requests` RENAME TO `api_requests`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_api_requests_narrator` ON `api_requests` (`narrator_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_api_requests_message` ON `api_requests` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_api_requests_provider` ON `api_requests` (`provider`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_api_requests_kind` ON `api_requests` (`kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_api_requests_created` ON `api_requests` (`created_at`);