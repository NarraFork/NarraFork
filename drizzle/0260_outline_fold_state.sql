PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `outline_fold_state` (
	`user_id` text NOT NULL,
	`space_id` text NOT NULL,
	`block_id` text NOT NULL,
	`open` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `space_id`, `block_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`space_id`) REFERENCES `outline_spaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`block_id`) REFERENCES `outline_blocks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_outline_fold_state_written` ON `outline_fold_state` (`user_id`,`space_id`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `idx_outline_fold_state_block` ON `outline_fold_state` (`block_id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
