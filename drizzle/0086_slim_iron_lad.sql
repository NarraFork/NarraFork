CREATE TABLE `user_recent_tabs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tab_key` text NOT NULL,
	`section` text NOT NULL,
	`type` text NOT NULL,
	`entity_id` text NOT NULL,
	`narrator_id` text,
	`represented_narrator_id` text,
	`parent_narrator_id` text,
	`workspace_id` text,
	`title` text NOT NULL,
	`subtitle` text,
	`status` text,
	`last_visited_at` integer NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`is_scheduled` integer DEFAULT false NOT NULL,
	`sort_order` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_user_recent_tabs_user_key` ON `user_recent_tabs` (`user_id`,`tab_key`);--> statement-breakpoint
CREATE INDEX `idx_user_recent_tabs_user_section_order` ON `user_recent_tabs` (`user_id`,`section`,`sort_order`,`tab_key`);--> statement-breakpoint
CREATE INDEX `idx_user_recent_tabs_user_workspace` ON `user_recent_tabs` (`user_id`,`workspace_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `idx_user_recent_tabs_narrator` ON `user_recent_tabs` (`represented_narrator_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `idx_user_recent_tabs_entity` ON `user_recent_tabs` (`type`,`entity_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `user_recent_tabs_meta` (
	`user_id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`migrated_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
