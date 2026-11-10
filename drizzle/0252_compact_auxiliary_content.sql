PRAGMA foreign_keys=OFF;
--> statement-breakpoint
ALTER TABLE `user_preferences` ADD `compact_auxiliary_content` integer DEFAULT true NOT NULL;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
