CREATE TABLE `chapter_commits` (
	`id` text PRIMARY KEY NOT NULL,
	`chapter_id` text NOT NULL,
	`sha` text NOT NULL,
	`message` text NOT NULL,
	`full_message` text,
	`author_name` text,
	`author_email` text,
	`authored_at` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`narrator_id` text,
	`narrator_message_id` text,
	`files_changed` integer,
	`lines_added` integer,
	`lines_removed` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`narrator_message_id`) REFERENCES `narrator_messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_chapter_commits_sha` ON `chapter_commits` (`chapter_id`,`sha`);--> statement-breakpoint
CREATE INDEX `idx_chapter_commits_chapter` ON `chapter_commits` (`chapter_id`,`authored_at`);--> statement-breakpoint
CREATE INDEX `idx_chapter_commits_narrator` ON `chapter_commits` (`narrator_id`);--> statement-breakpoint
CREATE TABLE `chapter_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_id` text NOT NULL,
	`target_id` text NOT NULL,
	`type` text NOT NULL,
	`metadata` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_chapter_edges_src_tgt_type` ON `chapter_edges` (`source_id`,`target_id`,`type`);--> statement-breakpoint
CREATE INDEX `idx_chapter_edges_project` ON `chapter_edges` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_chapter_edges_source` ON `chapter_edges` (`source_id`);--> statement-breakpoint
CREATE INDEX `idx_chapter_edges_target` ON `chapter_edges` (`target_id`);--> statement-breakpoint
CREATE TABLE `chapters` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'active' NOT NULL,
	`role` text DEFAULT 'branch' NOT NULL,
	`branch` text NOT NULL,
	`worktree_path` text,
	`base_branch` text NOT NULL,
	`parent_chapter_id` text,
	`fork_point` text,
	`merged_into_chapter_id` text,
	`merge_commit_sha` text,
	`merge_strategy` text,
	`pre_merge_target_sha` text,
	`container_config` text,
	`exploration_group_id` text,
	`is_root` integer DEFAULT 0,
	`head_commit_sha` text,
	`start_commit_sha` text,
	`commit_count` integer DEFAULT 0,
	`color` text,
	`group_label` text,
	`pinned` integer DEFAULT 0,
	`position_x` real,
	`position_y` real,
	`panel_expanded` integer DEFAULT 0,
	`panel_width` real,
	`panel_height` real,
	`review_source_chapter_id` text,
	`review_status` text,
	`last_accessed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`merged_into_chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`exploration_group_id`) REFERENCES `exploration_groups`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`review_source_chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_chapters_project` ON `chapters` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_chapters_parent` ON `chapters` (`parent_chapter_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_chapters_project_branch` ON `chapters` (`project_id`,`branch`);--> statement-breakpoint
CREATE TABLE `container_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`chapter_id` text NOT NULL,
	`container_id` text,
	`service_name` text NOT NULL,
	`status` text DEFAULT 'created' NOT NULL,
	`host_port` integer,
	`container_port` integer,
	`proxy_label` text,
	`container_ip` text,
	`volume_name` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `exploration_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`base_chapter_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`decided_chapter_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`base_chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`decided_chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `merge_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`target_chapter_id` text NOT NULL,
	`source_chapter_ids` text NOT NULL,
	`strategy` text DEFAULT 'merge' NOT NULL,
	`status` text NOT NULL,
	`current_index` integer DEFAULT 0 NOT NULL,
	`merged_count` integer DEFAULT 0 NOT NULL,
	`current_source_chapter_id` text,
	`conflict_files` text,
	`error` text,
	`locale` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`target_chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `narrator_blacklist_cmds` (
	`id` text PRIMARY KEY NOT NULL,
	`narrator_id` text NOT NULL,
	`pattern` text NOT NULL,
	`deny_prompt` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_blacklist_cmds_narrator` ON `narrator_blacklist_cmds` (`narrator_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_blacklist_cmds_narrator_pattern` ON `narrator_blacklist_cmds` (`narrator_id`,`pattern`);--> statement-breakpoint
CREATE TABLE `narrator_blacklist_dirs` (
	`id` text PRIMARY KEY NOT NULL,
	`narrator_id` text NOT NULL,
	`path` text NOT NULL,
	`deny_level` text DEFAULT 'denyAll' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_blacklist_dirs_narrator` ON `narrator_blacklist_dirs` (`narrator_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_blacklist_dirs_narrator_path` ON `narrator_blacklist_dirs` (`narrator_id`,`path`);--> statement-breakpoint
CREATE TABLE `narrator_file_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`narrator_id` text NOT NULL,
	`file_path` text NOT NULL,
	`original_content` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_file_snapshots_narrator` ON `narrator_file_snapshots` (`narrator_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_file_snapshots_narrator_file` ON `narrator_file_snapshots` (`narrator_id`,`file_path`);--> statement-breakpoint
CREATE TABLE `narrator_message_refs` (
	`id` text PRIMARY KEY NOT NULL,
	`narrator_id` text NOT NULL,
	`message_id` text NOT NULL,
	`seq` integer NOT NULL,
	`is_compact` integer DEFAULT 0 NOT NULL,
	`pruned_percent` integer,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `narrator_messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_narrator_refs_unique` ON `narrator_message_refs` (`narrator_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `idx_narrator_refs_seq` ON `narrator_message_refs` (`narrator_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_narrator_refs_message` ON `narrator_message_refs` (`message_id`);--> statement-breakpoint
CREATE TABLE `narrator_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`narrator_id` text NOT NULL,
	`sdk_message_uuid` text,
	`parent_tool_use_id` text,
	`role` text NOT NULL,
	`content_json` text NOT NULL,
	`content_text` text,
	`tokens_in` integer,
	`cost_usd` real,
	`turn_usage_json` text,
	`context_percent` real,
	`meter_usage` real,
	`meter_unit` text,
	`commit_sha` text,
	`command_text` text,
	`created_by` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_messages_narrator` ON `narrator_messages` (`narrator_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_messages_parent_tool_use_lookup` ON `narrator_messages` (`parent_tool_use_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_parent_tool_use` ON `narrator_messages` (`narrator_id`,`parent_tool_use_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_toplevel` ON `narrator_messages` (`narrator_id`,`parent_tool_use_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `narrator_patches` (
	`id` text PRIMARY KEY NOT NULL,
	`narrator_id` text NOT NULL,
	`message_id` text NOT NULL,
	`tool_use_id` text NOT NULL,
	`before_hash` text NOT NULL,
	`after_hash` text NOT NULL,
	`files_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `narrator_messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_patches_narrator` ON `narrator_patches` (`narrator_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_patches_message` ON `narrator_patches` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_patches_tool_use` ON `narrator_patches` (`tool_use_id`);--> statement-breakpoint
CREATE TABLE `narrator_tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`narrator_id` text NOT NULL,
	`message_id` text NOT NULL,
	`tool_use_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`input_json` text,
	`output_json` text,
	`status` text DEFAULT 'initializing' NOT NULL,
	`duration_ms` integer,
	`error_message` text,
	`permission_decided_by` text,
	`permission_decided_at` text,
	`permission_deny_message` text,
	`permission_decision_reason` text,
	`permission_suggestions` text,
	`is_background` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `narrator_messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_toolcalls_message` ON `narrator_tool_calls` (`message_id`);--> statement-breakpoint
CREATE INDEX `idx_toolcalls_tool_use_id` ON `narrator_tool_calls` (`tool_use_id`);--> statement-breakpoint
CREATE INDEX `idx_toolcalls_status` ON `narrator_tool_calls` (`narrator_id`,`status`);--> statement-breakpoint
CREATE TABLE `narrator_whitelist_cmds` (
	`id` text PRIMARY KEY NOT NULL,
	`narrator_id` text NOT NULL,
	`pattern` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_whitelist_cmds_narrator` ON `narrator_whitelist_cmds` (`narrator_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_whitelist_cmds_narrator_pattern` ON `narrator_whitelist_cmds` (`narrator_id`,`pattern`);--> statement-breakpoint
CREATE TABLE `narrator_whitelist_dirs` (
	`id` text PRIMARY KEY NOT NULL,
	`narrator_id` text NOT NULL,
	`path` text NOT NULL,
	`access_level` text DEFAULT 'readOnly' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_whitelist_dirs_narrator` ON `narrator_whitelist_dirs` (`narrator_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_whitelist_dirs_narrator_path` ON `narrator_whitelist_dirs` (`narrator_id`,`path`);--> statement-breakpoint
CREATE TABLE `narrators` (
	`id` text PRIMARY KEY NOT NULL,
	`chapter_id` text,
	`api_conversation_id` text,
	`fork_message_id` text,
	`type` text DEFAULT 'primary' NOT NULL,
	`subagent_type` text,
	`title` text,
	`inherit_mode` text DEFAULT 'fresh' NOT NULL,
	`parent_narrator_id` text,
	`context_summary` text,
	`model` text DEFAULT 'claude-sonnet-4.5',
	`system_prompt` text,
	`permission_mode` text DEFAULT 'default',
	`previous_permission_mode` text,
	`reasoning_effort` text,
	`fast_mode` integer DEFAULT false NOT NULL,
	`relaxed_plan` integer DEFAULT false NOT NULL,
	`message_count` integer DEFAULT 0,
	`total_cost_usd` real DEFAULT 0,
	`last_message_at` text,
	`status` text DEFAULT 'idle' NOT NULL,
	`plan_mode` integer DEFAULT false NOT NULL,
	`cwd` text,
	`error_message` text,
	`todos_json` text,
	`todos_tool_use_id` text,
	`prune_boundary_message_id` text,
	`pruned_percent` integer,
	`prune_enabled` integer DEFAULT true NOT NULL,
	`is_background` integer DEFAULT false NOT NULL,
	`background_status` text,
	`background_result` text,
	`background_completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fork_message_id`) REFERENCES `narrator_messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`prune_boundary_message_id`) REFERENCES `narrator_messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_narrators_chapter` ON `narrators` (`chapter_id`);--> statement-breakpoint
CREATE INDEX `idx_narrators_parent` ON `narrators` (`parent_narrator_id`);--> statement-breakpoint
CREATE TABLE `port_allocations` (
	`port` integer PRIMARY KEY NOT NULL,
	`chapter_id` text,
	`service_name` text,
	`allocated_at` text NOT NULL,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'active' NOT NULL,
	`flow_mode` text DEFAULT 'classic' NOT NULL,
	`git_path` text,
	`remote_url` text,
	`default_branch` text DEFAULT 'main',
	`startup_script` text,
	`copy_files` text,
	`chapter_settings` text,
	`proxy_domain` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `terminal_tabs` (
	`id` text PRIMARY KEY NOT NULL,
	`chapter_id` text,
	`narrator_id` text,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_terminal_tabs_chapter` ON `terminal_tabs` (`chapter_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `idx_terminal_tabs_narrator` ON `terminal_tabs` (`narrator_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `terminal_view_state` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`chapter_id` text,
	`narrator_id` text,
	`layout` text DEFAULT 'single' NOT NULL,
	`active_tab_id` text,
	`panel_assignments` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_view_state_user_chapter` ON `terminal_view_state` (`user_id`,`chapter_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_view_state_user_narrator` ON `terminal_view_state` (`user_id`,`narrator_id`);--> statement-breakpoint
CREATE TABLE `terminals` (
	`id` text PRIMARY KEY NOT NULL,
	`chapter_id` text,
	`narrator_id` text,
	`name` text NOT NULL,
	`cwd` text,
	`dtach_socket` text,
	`status` text DEFAULT 'running' NOT NULL,
	`exit_code` integer,
	`graph_opened` integer DEFAULT 0 NOT NULL,
	`graph_x` real,
	`graph_y` real,
	`graph_width` real,
	`graph_height` real,
	`created_at` text NOT NULL,
	FOREIGN KEY (`chapter_id`) REFERENCES `chapters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_terminals_chapter` ON `terminals` (`chapter_id`);--> statement-breakpoint
CREATE INDEX `idx_terminals_narrator` ON `terminals` (`narrator_id`);--> statement-breakpoint
CREATE INDEX `idx_terminals_status` ON `terminals` (`status`);--> statement-breakpoint
CREATE TABLE `user_favorite_directories` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`path` text NOT NULL,
	`label` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_fav_dirs_user` ON `user_favorite_directories` (`user_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `user_preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`auto_load_older_messages` integer DEFAULT true NOT NULL,
	`language` text DEFAULT 'en' NOT NULL,
	`word_wrap_markdown` integer DEFAULT true NOT NULL,
	`word_wrap_code` integer DEFAULT true NOT NULL,
	`word_wrap_diff` integer DEFAULT true NOT NULL,
	`reply_in_user_language` integer DEFAULT true NOT NULL,
	`show_token_usage` integer DEFAULT false NOT NULL,
	`show_output_stats` integer DEFAULT true NOT NULL,
	`terminal_theme` text DEFAULT 'auto' NOT NULL,
	`terminal_font_size` integer DEFAULT 14 NOT NULL,
	`recent_tabs` text DEFAULT '[]' NOT NULL,
	`notify_on_done` integer DEFAULT true NOT NULL,
	`notify_on_waiting` integer DEFAULT true NOT NULL,
	`notify_pwa_enabled` integer DEFAULT false NOT NULL,
	`notify_sound_enabled` integer DEFAULT true NOT NULL,
	`notify_sound_type` text DEFAULT 'builtin' NOT NULL,
	`notify_sound_builtin` text DEFAULT 'gentle' NOT NULL,
	`notify_sound_file_id` text,
	`notify_dingtalk_enabled` integer DEFAULT false NOT NULL,
	`notify_dingtalk_webhook` text DEFAULT '' NOT NULL,
	`notify_dingtalk_secret` text DEFAULT '' NOT NULL,
	`notify_feishu_enabled` integer DEFAULT false NOT NULL,
	`notify_feishu_webhook` text DEFAULT '' NOT NULL,
	`notify_feishu_secret` text DEFAULT '' NOT NULL,
	`commands` text DEFAULT '[]' NOT NULL,
	`graph_viewports` text DEFAULT '{}' NOT NULL,
	`send_mode` text DEFAULT 'enter' NOT NULL,
	`setup_wizard_completed` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_preferences_user_id_unique` ON `user_preferences` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`avatar_color` text,
	`avatar_image_id` text,
	`git_username` text,
	`git_email` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);