PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `narrator_block_index_queue` (
	`block_id` text PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`block_id`) REFERENCES `narrator_blocks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `narrator_blocks` ADD `ledger_revision` text;
--> statement-breakpoint
ALTER TABLE `narrator_messages` ADD `blocks_content_hash` text;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
