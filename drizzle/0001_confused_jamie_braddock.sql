ALTER TABLE `chapters` ADD `anchor_commit_sha` text;--> statement-breakpoint
ALTER TABLE `chapters` ADD `axis_offset` real DEFAULT 0;--> statement-breakpoint
ALTER TABLE `chapters` ADD `cross_offset` real DEFAULT 0;--> statement-breakpoint
ALTER TABLE `chapters` DROP COLUMN `position_x`;--> statement-breakpoint
ALTER TABLE `chapters` DROP COLUMN `position_y`;