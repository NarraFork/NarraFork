PRAGMA foreign_keys=OFF;
--> statement-breakpoint
ALTER TABLE `user_preferences` ADD `recent_tabs_show_directory` integer DEFAULT false NOT NULL;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
