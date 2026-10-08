ALTER TABLE `file_change_scopes` ADD `active_lease_id` text;--> statement-breakpoint
ALTER TABLE `file_change_scopes` ADD `active_lease_epoch` text;--> statement-breakpoint
ALTER TABLE `file_change_scopes` ADD `active_lease_started_at` text;--> statement-breakpoint
ALTER TABLE `file_change_scopes` ADD `active_mutation_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_fc_scope_active_lease` ON `file_change_scopes` (`device_id`,`active_lease_id`,`canonical_root`);--> statement-breakpoint
ALTER TABLE `narrator_tool_calls` ADD `execution_identity_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `narrator_tool_calls` ADD `execution_origin_tool_call_id` text;