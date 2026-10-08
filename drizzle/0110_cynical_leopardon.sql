ALTER TABLE `chapters` ADD `merge_snapshot_commit_sha` text;--> statement-breakpoint
ALTER TABLE `chapters` ADD `pre_merge_target_snapshot_sha` text;--> statement-breakpoint
ALTER TABLE `chapters` ADD `merged_source_snapshot_sha` text;--> statement-breakpoint
ALTER TABLE `merge_sessions` ADD `pre_merge_tree` text;--> statement-breakpoint
ALTER TABLE `merge_sessions` ADD `conflict_tree` text;