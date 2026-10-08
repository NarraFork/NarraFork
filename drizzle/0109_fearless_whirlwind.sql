ALTER TABLE `chapters` ADD `snapshot_commit_sha` text;--> statement-breakpoint
ALTER TABLE `chapters` ADD `snapshot_shadow_key` text;--> statement-breakpoint
CREATE INDEX `idx_chapters_snapshot_shadow_key` ON `chapters` (`snapshot_shadow_key`);--> statement-breakpoint
ALTER TABLE `narrator_messages` ADD `snapshot_commit_sha` text;--> statement-breakpoint
ALTER TABLE `worktree_tree_snapshots` ADD `snapshot_commit_sha` text;