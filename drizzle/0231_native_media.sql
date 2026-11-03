PRAGMA foreign_keys=OFF;
--> statement-breakpoint
ALTER TABLE `narrator_buffered_messages` ADD `media_json` text;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
