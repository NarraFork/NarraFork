CREATE TABLE `remote_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`token_hash` text NOT NULL,
	`token_prefix` text NOT NULL,
	`connection_mode` text DEFAULT 'reverse' NOT NULL,
	`direct_url` text,
	`status` text DEFAULT 'offline' NOT NULL,
	`last_seen_at` text,
	`platform_os` text,
	`platform_arch` text,
	`shell_path` text,
	`default_cwd` text,
	`agent_version` text,
	`capabilities_json` text,
	`scope` text DEFAULT 'global' NOT NULL,
	`project_id` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_remote_devices_slug` ON `remote_devices` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_remote_devices_status` ON `remote_devices` (`status`);--> statement-breakpoint
CREATE INDEX `idx_remote_devices_project` ON `remote_devices` (`project_id`);--> statement-breakpoint
ALTER TABLE `narrators` ADD `default_device_id` text;