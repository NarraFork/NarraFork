CREATE TABLE `hooks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`event` text NOT NULL,
	`matcher` text DEFAULT '' NOT NULL,
	`type` text NOT NULL,
	`command` text,
	`url` text,
	`headers` text,
	`prompt` text,
	`model` text,
	`timeout` integer DEFAULT 30 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hooks_project` ON `hooks` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_hooks_event` ON `hooks` (`event`,`enabled`);