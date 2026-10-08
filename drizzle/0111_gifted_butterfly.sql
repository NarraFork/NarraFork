ALTER TABLE `merge_sessions` ADD `pre_merge_target_snapshot` text;--> statement-breakpoint
ALTER TABLE `merge_sessions` ADD `merge_source_snapshot` text;--> statement-breakpoint
ALTER TABLE `merge_sessions` ADD `pre_merge_target_sha` text;