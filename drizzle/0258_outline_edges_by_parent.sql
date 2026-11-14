PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE INDEX `idx_outline_edges_open` ON `outline_block_edges` (`parent_key`,`order_key`,`block_id`,`from_seq`) WHERE "to_seq" IS NULL;
--> statement-breakpoint
CREATE INDEX `idx_outline_edges_closed` ON `outline_block_edges` (`parent_key`,`to_seq`,`from_seq`,`order_key`,`block_id`) WHERE "to_seq" IS NOT NULL;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
