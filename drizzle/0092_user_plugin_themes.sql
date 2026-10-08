CREATE TABLE `user_plugin_themes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`plugin_id` text NOT NULL,
	`theme_id` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_user_plugin_themes_unique` ON `user_plugin_themes` (`user_id`,`plugin_id`,`theme_id`);--> statement-breakpoint
CREATE INDEX `idx_user_plugin_themes_user` ON `user_plugin_themes` (`user_id`);--> statement-breakpoint
DROP TABLE `narrator_message_render_index_v2`;--> statement-breakpoint
DROP TABLE `narrator_message_render_index`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_terminal_view_state` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`chapter_id` text,
	`narrator_id` text,
	`layout` text DEFAULT 'single' NOT NULL,
	`active_tab_id` text,
	`panel_assignments` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_terminal_view_state`("id", "user_id", "chapter_id", "narrator_id", "layout", "active_tab_id", "panel_assignments", "updated_at") SELECT "id", "user_id", "chapter_id", "narrator_id", "layout", "active_tab_id", "panel_assignments", "updated_at" FROM `terminal_view_state`;--> statement-breakpoint
DROP TABLE `terminal_view_state`;--> statement-breakpoint
ALTER TABLE `__new_terminal_view_state` RENAME TO `terminal_view_state`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_view_state_user_chapter` ON `terminal_view_state` (`user_id`,`chapter_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_view_state_user_narrator` ON `terminal_view_state` (`user_id`,`narrator_id`);