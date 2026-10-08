PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_narrators` (
	`id` text PRIMARY KEY NOT NULL,
	`chapter_id` text,
	`api_conversation_id` text,
	`logical_run_id` text,
	`inbox_sequence` integer DEFAULT 0 NOT NULL,
	`fork_message_id` text,
	`type` text DEFAULT 'primary' NOT NULL,
	`subagent_type` text,
	`title` text,
	`inherit_mode` text DEFAULT 'fresh' NOT NULL,
	`parent_narrator_id` text,
	`origin_tool_call_id` text,
	`subagent_origin_kind` text,
	`context_summary` text,
	`model` text DEFAULT 'claude-sonnet-4.5',
	`pending_model_restore` text,
	`system_prompt` text,
	`permission_mode` text DEFAULT 'default',
	`previous_permission_mode` text,
	`plan_file_id` text,
	`reasoning_effort` text,
	`fast_mode` integer DEFAULT false NOT NULL,
	`fast_mode_override` text DEFAULT 'inherit' NOT NULL,
	`relaxed_plan` integer DEFAULT false NOT NULL,
	`plan_reflection_auto_approve_override` text DEFAULT 'inherit' NOT NULL,
	`danger_reflection_override` text DEFAULT 'inherit' NOT NULL,
	`auto_continuation_override` text DEFAULT 'inherit' NOT NULL,
	`behavior_fence_interval_override` integer,
	`tasks_reminder_interval_override` integer,
	`behavior_fence_attach_override` text DEFAULT 'inherit' NOT NULL,
	`message_count` integer DEFAULT 0,
	`total_cost_usd` real DEFAULT 0,
	`last_message_at` text,
	`status` text DEFAULT 'idle' NOT NULL,
	`substatus` text DEFAULT '[]' NOT NULL,
	`plan_mode` integer DEFAULT false NOT NULL,
	`cwd` text,
	`error_message` text,
	`error_retryable` integer,
	`refs_inherited_from` text,
	`refs_backfill_cursor` integer,
	`enabled_tools` text,
	`variant` text DEFAULT 'primary' NOT NULL,
	`traits` text DEFAULT '[]' NOT NULL,
	`handle` text,
	`handle_fold` text,
	`is_background` integer DEFAULT false NOT NULL,
	`background_status` text,
	`background_result` text,
	`background_completed_at` text,
	`is_ask_in_passing` integer DEFAULT false NOT NULL,
	`turn_started_at` text,
	`message_version` integer DEFAULT 0 NOT NULL,
	`message_structure_version` integer DEFAULT 0 NOT NULL,
	`default_device_id` text,
	`oauth_owner_grant_id` text,
	`oauth_provision_key` text,
	`context_project_id` text,
	`oauth_policy_snapshot_json` text,
	`avatar_image_id` text,
	`owner_user_id` text,
	`visibility` text DEFAULT 'private' NOT NULL,
	`write_audience` text DEFAULT 'owner' NOT NULL,
	`acl_root_narrator_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fork_message_id`) REFERENCES `narrator_messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`refs_inherited_from`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`oauth_owner_grant_id`) REFERENCES `oauth_grants`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`context_project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`acl_root_narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_narrators`("id", "chapter_id", "api_conversation_id", "logical_run_id", "inbox_sequence", "fork_message_id", "type", "subagent_type", "title", "inherit_mode", "parent_narrator_id", "origin_tool_call_id", "subagent_origin_kind", "context_summary", "model", "pending_model_restore", "system_prompt", "permission_mode", "previous_permission_mode", "plan_file_id", "reasoning_effort", "fast_mode", "fast_mode_override", "relaxed_plan", "plan_reflection_auto_approve_override", "danger_reflection_override", "auto_continuation_override", "behavior_fence_interval_override", "tasks_reminder_interval_override", "behavior_fence_attach_override", "message_count", "total_cost_usd", "last_message_at", "status", "substatus", "plan_mode", "cwd", "error_message", "error_retryable", "refs_inherited_from", "refs_backfill_cursor", "enabled_tools", "variant", "traits", "handle", "handle_fold", "is_background", "background_status", "background_result", "background_completed_at", "is_ask_in_passing", "turn_started_at", "message_version", "message_structure_version", "default_device_id", "oauth_owner_grant_id", "oauth_provision_key", "context_project_id", "oauth_policy_snapshot_json", "avatar_image_id", "owner_user_id", "visibility", "write_audience", "acl_root_narrator_id", "created_at", "updated_at") SELECT "id", "chapter_id", "api_conversation_id", "logical_run_id", "inbox_sequence", "fork_message_id", "type", "subagent_type", "title", "inherit_mode", "parent_narrator_id", "origin_tool_call_id", "subagent_origin_kind", "context_summary", "model", "pending_model_restore", "system_prompt", "permission_mode", "previous_permission_mode", "plan_file_id", "reasoning_effort", "fast_mode", "fast_mode_override", "relaxed_plan", "plan_reflection_auto_approve_override", "danger_reflection_override", "auto_continuation_override", "behavior_fence_interval_override", "tasks_reminder_interval_override", "behavior_fence_attach_override", "message_count", "total_cost_usd", "last_message_at", "status", "substatus", "plan_mode", "cwd", "error_message", "error_retryable", "refs_inherited_from", "refs_backfill_cursor", "enabled_tools", "variant", "traits", "handle", "handle_fold", "is_background", "background_status", "background_result", "background_completed_at", "is_ask_in_passing", "turn_started_at", "message_version", "message_structure_version", "default_device_id", "oauth_owner_grant_id", "oauth_provision_key", "context_project_id", "oauth_policy_snapshot_json", "avatar_image_id", "owner_user_id", "visibility", "write_audience", "acl_root_narrator_id", "created_at", "updated_at" FROM `narrators`;--> statement-breakpoint
DROP TABLE `narrators`;--> statement-breakpoint
ALTER TABLE `__new_narrators` RENAME TO `narrators`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_narrators_chapter` ON `narrators` (`chapter_id`);--> statement-breakpoint
CREATE INDEX `idx_narrators_parent` ON `narrators` (`parent_narrator_id`);--> statement-breakpoint
CREATE INDEX `idx_narrators_origin_tool_call` ON `narrators` (`origin_tool_call_id`);--> statement-breakpoint
CREATE INDEX `idx_narrators_owner` ON `narrators` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `idx_narrators_visibility` ON `narrators` (`visibility`);--> statement-breakpoint
CREATE INDEX `idx_narrators_write_audience` ON `narrators` (`write_audience`);--> statement-breakpoint
CREATE INDEX `idx_narrators_acl_root` ON `narrators` (`acl_root_narrator_id`);--> statement-breakpoint
CREATE INDEX `idx_narrators_variant_updated` ON `narrators` (`variant`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_narrators_handle` ON `narrators` (`handle`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_narrators_handle_fold` ON `narrators` (`handle_fold`);--> statement-breakpoint
CREATE INDEX `idx_narrators_context_project` ON `narrators` (`context_project_id`);--> statement-breakpoint
CREATE INDEX `idx_narrators_oauth_owner` ON `narrators` (`oauth_owner_grant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_narrators_oauth_provision` ON `narrators` (`oauth_owner_grant_id`,`oauth_provision_key`);--> statement-breakpoint
CREATE INDEX `idx_narrators_fork_message` ON `narrators` (`fork_message_id`);--> statement-breakpoint
CREATE INDEX `idx_narrators_refs_inherited_from` ON `narrators` (`refs_inherited_from`) WHERE "refs_inherited_from" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_narrators_background_parent_created` ON `narrators` (`parent_narrator_id`,`created_at`,`id`) WHERE "is_background" = 1;--> statement-breakpoint
ALTER TABLE `narrator_message_refs` DROP COLUMN `pruned_percent`;