PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `outline_pending` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`page_id` text NOT NULL,
	`root_block_id` text,
	`ops_json` text NOT NULL,
	`base_json` text NOT NULL,
	`op_count` integer NOT NULL,
	`subtree_json` text NOT NULL,
	`block_ids_json` text NOT NULL,
	`adds_json` text NOT NULL,
	`summary` text NOT NULL,
	`requested_by_json` text NOT NULL,
	`requester_session` text,
	`decider_json` text NOT NULL,
	`decider_user_id` text,
	`rev` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`decided_at` text,
	`decided_by_json` text,
	`decision_commit_id` text,
	`reason` text,
	`reported_at` text,
	FOREIGN KEY (`space_id`) REFERENCES `outline_spaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_outline_pending_space` ON `outline_pending` (`space_id`);
--> statement-breakpoint
CREATE INDEX `idx_outline_pending_page_open` ON `outline_pending` (`page_id`) WHERE "status" = 'open';
--> statement-breakpoint
CREATE INDEX `idx_outline_pending_root_open` ON `outline_pending` (`root_block_id`) WHERE "status" = 'open';
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_outline_pending_open_proposer` ON `outline_pending` (`requester_session`,`root_block_id`) WHERE "status" = 'open';
--> statement-breakpoint
CREATE INDEX `idx_outline_pending_unreported` ON `outline_pending` (`requester_session`,`page_id`) WHERE "reported_at" IS NULL AND "status" <> 'open';
--> statement-breakpoint
CREATE INDEX `idx_outline_pending_decider_open` ON `outline_pending` (`decider_user_id`) WHERE "status" = 'open';
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_outline_pending_decision_commit` ON `outline_pending` (`decision_commit_id`);
--> statement-breakpoint
CREATE INDEX `idx_outline_blocks_locked` ON `outline_blocks` (`page_id`) WHERE json_extract("task_json", '$.lock') IS NOT NULL AND "deleted" = 0;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
