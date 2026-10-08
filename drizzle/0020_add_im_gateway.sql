CREATE TABLE `gateway_platforms` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`config_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gateway_session_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`chat_id` text NOT NULL,
	`user_id` text NOT NULL,
	`username` text,
	`narrator_id` text NOT NULL REFERENCES `narrators`(`id`) ON DELETE cascade,
	`project_id` text REFERENCES `projects`(`id`) ON DELETE set null,
	`chapter_id` text REFERENCES `chapters`(`id`) ON DELETE set null,
	`last_message_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_gsm_platform_chat_user` ON `gateway_session_mappings` (`platform`,`chat_id`,`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_gsm_narrator` ON `gateway_session_mappings` (`narrator_id`);
