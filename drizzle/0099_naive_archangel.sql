CREATE TABLE `worktree_tree_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text DEFAULT 'local' NOT NULL,
	`worktree_path` text NOT NULL,
	`tree_hash` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_worktree_tree_snapshots_unique` ON `worktree_tree_snapshots` (`device_id`,`worktree_path`,`tree_hash`);--> statement-breakpoint
CREATE INDEX `idx_worktree_tree_snapshots_path` ON `worktree_tree_snapshots` (`device_id`,`worktree_path`,`created_at`);--> statement-breakpoint
ALTER TABLE `narrator_messages` ADD `tree_hash_after` text;--> statement-breakpoint
ALTER TABLE `narrator_tool_calls` ADD `tree_hash_before` text;--> statement-breakpoint
ALTER TABLE `narrator_tool_calls` ADD `tree_hash_after` text;