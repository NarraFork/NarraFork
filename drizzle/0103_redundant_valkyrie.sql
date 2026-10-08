DROP INDEX `idx_blacklist_cmds_narrator_pattern`;--> statement-breakpoint
ALTER TABLE `narrator_blacklist_cmds` ADD `target_kind` text;--> statement-breakpoint
ALTER TABLE `narrator_blacklist_cmds` ADD `target_value` text;--> statement-breakpoint
ALTER TABLE `narrator_blacklist_cmds` ADD `device_scope` text;--> statement-breakpoint
ALTER TABLE `narrator_blacklist_cmds` ADD `updated_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_blacklist_cmds_narrator_pattern_unscoped` ON `narrator_blacklist_cmds` (`narrator_id`,`pattern`) WHERE "narrator_blacklist_cmds"."device_scope" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_blacklist_cmds_narrator_pattern_scoped` ON `narrator_blacklist_cmds` (`narrator_id`,`pattern`,`device_scope`) WHERE "narrator_blacklist_cmds"."device_scope" is not null;--> statement-breakpoint
DROP INDEX `idx_blacklist_dirs_narrator_path`;--> statement-breakpoint
ALTER TABLE `narrator_blacklist_dirs` ADD `path_flavor` text;--> statement-breakpoint
ALTER TABLE `narrator_blacklist_dirs` ADD `path_key` text;--> statement-breakpoint
ALTER TABLE `narrator_blacklist_dirs` ADD `target_kind` text;--> statement-breakpoint
ALTER TABLE `narrator_blacklist_dirs` ADD `target_value` text;--> statement-breakpoint
ALTER TABLE `narrator_blacklist_dirs` ADD `device_scope` text;--> statement-breakpoint
ALTER TABLE `narrator_blacklist_dirs` ADD `updated_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_blacklist_dirs_narrator_path_unscoped` ON `narrator_blacklist_dirs` (`narrator_id`,`path`) WHERE "narrator_blacklist_dirs"."device_scope" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_blacklist_dirs_narrator_path_scoped` ON `narrator_blacklist_dirs` (`narrator_id`,`path`,`device_scope`) WHERE "narrator_blacklist_dirs"."device_scope" is not null;--> statement-breakpoint
DROP INDEX `idx_whitelist_cmds_narrator_pattern`;--> statement-breakpoint
ALTER TABLE `narrator_whitelist_cmds` ADD `target_kind` text;--> statement-breakpoint
ALTER TABLE `narrator_whitelist_cmds` ADD `target_value` text;--> statement-breakpoint
ALTER TABLE `narrator_whitelist_cmds` ADD `device_scope` text;--> statement-breakpoint
ALTER TABLE `narrator_whitelist_cmds` ADD `updated_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_whitelist_cmds_narrator_pattern_unscoped` ON `narrator_whitelist_cmds` (`narrator_id`,`pattern`) WHERE "narrator_whitelist_cmds"."device_scope" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_whitelist_cmds_narrator_pattern_scoped` ON `narrator_whitelist_cmds` (`narrator_id`,`pattern`,`device_scope`) WHERE "narrator_whitelist_cmds"."device_scope" is not null;--> statement-breakpoint
DROP INDEX `idx_whitelist_dirs_narrator_path`;--> statement-breakpoint
ALTER TABLE `narrator_whitelist_dirs` ADD `path_flavor` text;--> statement-breakpoint
ALTER TABLE `narrator_whitelist_dirs` ADD `path_key` text;--> statement-breakpoint
ALTER TABLE `narrator_whitelist_dirs` ADD `target_kind` text;--> statement-breakpoint
ALTER TABLE `narrator_whitelist_dirs` ADD `target_value` text;--> statement-breakpoint
ALTER TABLE `narrator_whitelist_dirs` ADD `device_scope` text;--> statement-breakpoint
ALTER TABLE `narrator_whitelist_dirs` ADD `updated_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_whitelist_dirs_narrator_path_unscoped` ON `narrator_whitelist_dirs` (`narrator_id`,`path`) WHERE "narrator_whitelist_dirs"."device_scope" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_whitelist_dirs_narrator_path_scoped` ON `narrator_whitelist_dirs` (`narrator_id`,`path`,`device_scope`) WHERE "narrator_whitelist_dirs"."device_scope" is not null;--> statement-breakpoint
ALTER TABLE `narrator_tool_calls` ADD `execution_path_flavor` text;--> statement-breakpoint
ALTER TABLE `narrator_tool_calls` ADD `canonical_file_path` text;--> statement-breakpoint
ALTER TABLE `narrator_tool_calls` ADD `runtime_generation` integer;--> statement-breakpoint
ALTER TABLE `narrator_tool_calls` ADD `execution_targets_json` text;--> statement-breakpoint
ALTER TABLE `narrators` ADD `error_retryable` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_kgrant_unique_scoped_tagged` ON `knowledge_grants` (`collection_id`,`principal_type`,`principal_id`,`grant_type`,`tag_id`) WHERE "knowledge_grants"."collection_id" is not null and "knowledge_grants"."tag_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_kgrant_unique_scoped_untagged` ON `knowledge_grants` (`collection_id`,`principal_type`,`principal_id`,`grant_type`) WHERE "knowledge_grants"."collection_id" is not null and "knowledge_grants"."tag_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_kgrant_unique_global_tagged` ON `knowledge_grants` (`principal_type`,`principal_id`,`grant_type`,`tag_id`) WHERE "knowledge_grants"."collection_id" is null and "knowledge_grants"."tag_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_kgrant_unique_global_untagged` ON `knowledge_grants` (`principal_type`,`principal_id`,`grant_type`) WHERE "knowledge_grants"."collection_id" is null and "knowledge_grants"."tag_id" is null;