PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `outline_digests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`period_key` text NOT NULL,
	`time_zone` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`counts_json` text NOT NULL,
	`item_count` integer DEFAULT 0 NOT NULL,
	`items_json` text NOT NULL,
	`ranges_json` text NOT NULL,
	`truncated` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`seen_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_outline_digests_user_period` ON `outline_digests` (`user_id`,`kind`,`period_key`);
--> statement-breakpoint
CREATE INDEX `idx_outline_digests_unseen` ON `outline_digests` (`user_id`) WHERE "seen_at" IS NULL;
--> statement-breakpoint
ALTER TABLE `outline_spaces` ADD `last_commit_at` text;
--> statement-breakpoint
CREATE INDEX `idx_outline_spaces_last_commit` ON `outline_spaces` (`last_commit_at`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_outline_spaces_unstamped` ON `outline_spaces` (`id`) WHERE "last_commit_at" IS NULL AND "next_seq" > 1;
--> statement-breakpoint
ALTER TABLE `user_preferences` ADD `outline_digest_time_zone` text;
--> statement-breakpoint
ALTER TABLE `user_preferences` ADD `outline_digest_time` text;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
