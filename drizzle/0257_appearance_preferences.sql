PRAGMA foreign_keys=OFF;
--> statement-breakpoint
ALTER TABLE `user_preferences` ADD `appearance_preferences` text DEFAULT '{}' NOT NULL;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
