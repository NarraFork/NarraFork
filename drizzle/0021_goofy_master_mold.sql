CREATE TABLE `gateway_session_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`chat_id` text NOT NULL,
	`user_id` text NOT NULL,
	`username` text,
	`narrator_id` text NOT NULL,
	`project_id` text,
	`chapter_id` text,
	`last_message_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_gsm_platform_chat_user` ON `gateway_session_mappings` (`platform`,`chat_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `idx_gsm_narrator` ON `gateway_session_mappings` (`narrator_id`);--> statement-breakpoint
ALTER TABLE `user_preferences` ADD `gateway_config` text DEFAULT '{}' NOT NULL;