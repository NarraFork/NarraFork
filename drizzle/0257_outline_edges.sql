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
