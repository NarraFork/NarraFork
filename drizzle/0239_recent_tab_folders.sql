PRAGMA foreign_keys=OFF;
--> statement-breakpoint
ALTER TABLE `user_recent_tabs` ADD `folder_id` text;
--> statement-breakpoint
ALTER TABLE `user_recent_tabs` ADD `folder_icon` text;
--> statement-breakpoint
ALTER TABLE `user_recent_tabs` ADD `folder_color` text;
--> statement-breakpoint
ALTER TABLE `user_recent_tabs` ADD `folder_preview_count` integer;
--> statement-breakpoint
CREATE INDEX `idx_user_recent_tabs_user_folder` ON `user_recent_tabs` (`user_id`,`folder_id`,`sort_order`);
--> statement-breakpoint
ALTER TABLE `user_recent_tabs_meta` ADD `folders_migrated` integer DEFAULT false NOT NULL;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
