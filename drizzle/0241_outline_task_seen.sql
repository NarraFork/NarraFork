PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `outline_task_seen` (
	`user_id` text NOT NULL,
	`task_block_id` text NOT NULL,
	`seen_seq` integer NOT NULL,
	`seen_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `task_block_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_block_id`) REFERENCES `outline_blocks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_outline_task_seen_block` ON `outline_task_seen` (`task_block_id`);
--> statement-breakpoint
CREATE INDEX `idx_outline_task_seen_user_at` ON `outline_task_seen` (`user_id`,`seen_at`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
