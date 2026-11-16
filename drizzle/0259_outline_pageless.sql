PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `outline_block_edges` (
	`parent_key` text NOT NULL,
	`block_id` text NOT NULL,
	`from_seq` integer NOT NULL,
	`to_seq` integer,
	`order_key` text NOT NULL,
	PRIMARY KEY(`parent_key`, `block_id`, `from_seq`),
	FOREIGN KEY (`block_id`) REFERENCES `outline_blocks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_outline_edges_block` ON `outline_block_edges` (`block_id`,`from_seq`);
--> statement-breakpoint
CREATE INDEX `idx_outline_edges_open` ON `outline_block_edges` (`parent_key`,`order_key`,`block_id`,`from_seq`) WHERE "to_seq" IS NULL;
--> statement-breakpoint
CREATE INDEX `idx_outline_edges_closed` ON `outline_block_edges` (`parent_key`,`to_seq`,`from_seq`,`order_key`,`block_id`) WHERE "to_seq" IS NOT NULL;
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
CREATE TABLE `outline_live_log` (
	`space_id` text NOT NULL,
	`epoch` integer NOT NULL,
	`seq` integer NOT NULL,
	`update_b64` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`space_id`, `epoch`, `seq`),
	FOREIGN KEY (`space_id`) REFERENCES `outline_spaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `outline_subtree_changes` (
	`ancestor_id` text NOT NULL,
	`seq` integer NOT NULL,
	PRIMARY KEY(`ancestor_id`, `seq`),
	FOREIGN KEY (`ancestor_id`) REFERENCES `outline_blocks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `outline_spaces` ADD `history_floor_seq` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `outline_spaces` ADD `edges_ready` integer DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_outline_spaces_edges_pending` ON `outline_spaces` (`id`) WHERE "edges_ready" = 0;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
