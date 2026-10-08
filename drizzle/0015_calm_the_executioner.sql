CREATE TABLE `api_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`narrator_id` text NOT NULL,
	`message_id` text,
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
	`created_at` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `narrator_messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_api_requests_narrator` ON `api_requests` (`narrator_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_api_requests_message` ON `api_requests` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_api_requests_provider` ON `api_requests` (`provider`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_api_requests_created` ON `api_requests` (`created_at`);