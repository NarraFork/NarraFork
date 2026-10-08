CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`project_id` text,
	`chapter_id` text,
	`narrator_id` text,
	`title` text NOT NULL,
	`preview` text DEFAULT '' NOT NULL,
	`link_json` text NOT NULL,
	`source_key` text NOT NULL,
	`status` text DEFAULT 'unread' NOT NULL,
	`created_at` integer NOT NULL,
	`read_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_notifications_user_kind_source` ON `notifications` (`user_id`,`kind`,`source_key`);--> statement-breakpoint
CREATE INDEX `idx_notifications_user_created` ON `notifications` (`user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_notifications_user_status_created` ON `notifications` (`user_id`,`status`,`created_at`,`id`);