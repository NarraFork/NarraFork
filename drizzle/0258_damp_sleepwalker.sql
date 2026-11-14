PRAGMA foreign_keys=OFF;
--> statement-breakpoint
ALTER TABLE `user_preferences` ADD `hidden_plugin_overlays` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
