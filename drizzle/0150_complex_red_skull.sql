CREATE TABLE `file_change_blobs` (
	`id` text PRIMARY KEY NOT NULL,
	`digest` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`storage_key` text NOT NULL,
	`status` text DEFAULT 'staging' NOT NULL,
	`lease_until` text,
	`gc_generation` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_fc_blob_digest` ON `file_change_blobs` (`digest`);--> statement-breakpoint
CREATE INDEX `idx_fc_blob_gc` ON `file_change_blobs` (`status`,`lease_until`,`updated_at`);--> statement-breakpoint
CREATE TABLE `file_change_effects` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`scope_id` text NOT NULL,
	`file_key` text NOT NULL,
	`identity_json` text NOT NULL,
	`scope_revision` integer NOT NULL,
	`mutation_id` text NOT NULL,
	`request_digest` text NOT NULL,
	`phase` text NOT NULL,
	`before_state_json` text NOT NULL,
	`intended_after_state_json` text NOT NULL,
	`observed_after_state_json` text NOT NULL,
	`before_blob_digest` text,
	`intended_after_blob_digest` text,
	`observed_after_blob_digest` text,
	`outcome` text DEFAULT 'pending' NOT NULL,
	`settlement` text DEFAULT 'preparing' NOT NULL,
	`attribution_grade` text DEFAULT 'unknown' NOT NULL,
	`execution_confirmed` integer DEFAULT false NOT NULL,
	`lines_added` integer,
	`lines_removed` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `file_change_operations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scope_id`) REFERENCES `file_change_scopes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`before_blob_digest`) REFERENCES `file_change_blobs`(`digest`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`intended_after_blob_digest`) REFERENCES `file_change_blobs`(`digest`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`observed_after_blob_digest`) REFERENCES `file_change_blobs`(`digest`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_fc_effect_mutation` ON `file_change_effects` (`mutation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_fc_effect_operation_file` ON `file_change_effects` (`operation_id`,`file_key`,`phase`);--> statement-breakpoint
CREATE INDEX `idx_fc_effect_file` ON `file_change_effects` (`scope_id`,`file_key`,`scope_revision`,`id`);--> statement-breakpoint
CREATE INDEX `idx_fc_effect_pending` ON `file_change_effects` (`settlement`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_fc_effect_before_blob` ON `file_change_effects` (`before_blob_digest`);--> statement-breakpoint
CREATE INDEX `idx_fc_effect_intended_blob` ON `file_change_effects` (`intended_after_blob_digest`);--> statement-breakpoint
CREATE INDEX `idx_fc_effect_observed_blob` ON `file_change_effects` (`observed_after_blob_digest`);--> statement-breakpoint
CREATE TABLE `file_change_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`evidence_version` integer DEFAULT 2 NOT NULL,
	`source_instance_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`tool_call_id` text,
	`tool_use_id` text,
	`background_task_id` text,
	`narrator_id` text,
	`project_id` text,
	`owner_user_id` text,
	`actor_subject_key` text NOT NULL,
	`actor_json` text NOT NULL,
	`initiator_subject_key` text,
	`execution_binding_json` text,
	`execution_outcome` text DEFAULT 'running' NOT NULL,
	`effect_outcome` text DEFAULT 'pending' NOT NULL,
	`settlement` text DEFAULT 'preparing' NOT NULL,
	`attribution_grade` text DEFAULT 'unknown' NOT NULL,
	`coverage` text DEFAULT 'unavailable' NOT NULL,
	`parent_operation_id` text,
	`reason` text,
	`lease_until` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_fc_operation_attempt` ON `file_change_operations` (`source_instance_id`,`source_kind`,`source_id`,`attempt`);--> statement-breakpoint
CREATE INDEX `idx_fc_operation_narrator` ON `file_change_operations` (`narrator_id`,`started_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_fc_operation_actor` ON `file_change_operations` (`actor_subject_key`,`started_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_fc_operation_pending` ON `file_change_operations` (`settlement`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_fc_operation_task` ON `file_change_operations` (`background_task_id`,`attempt`);--> statement-breakpoint
CREATE INDEX `idx_fc_operation_parent` ON `file_change_operations` (`parent_operation_id`);--> statement-breakpoint
CREATE TABLE `file_change_rollups` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_id` text NOT NULL,
	`file_key` text NOT NULL,
	`actor_subject_key` text NOT NULL,
	`projection_kind` text NOT NULL,
	`attempt_key` text DEFAULT '' NOT NULL,
	`change_count` integer DEFAULT 0 NOT NULL,
	`lines_added` integer DEFAULT 0 NOT NULL,
	`lines_removed` integer DEFAULT 0 NOT NULL,
	`unmeasured_count` integer DEFAULT 0 NOT NULL,
	`has_external_change` integer DEFAULT false NOT NULL,
	`has_imprecise_attribution` integer DEFAULT true NOT NULL,
	`complete` integer DEFAULT false NOT NULL,
	`as_of_revision` integer,
	`last_effect_id` text,
	`head_fingerprint` text,
	`index_fingerprint` text,
	`worktree_fingerprint` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`scope_id`) REFERENCES `file_change_scopes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`last_effect_id`) REFERENCES `file_change_effects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_fc_rollup_dimension` ON `file_change_rollups` (`scope_id`,`file_key`,`actor_subject_key`,`projection_kind`,`attempt_key`);--> statement-breakpoint
CREATE INDEX `idx_fc_rollup_actor` ON `file_change_rollups` (`actor_subject_key`,`projection_kind`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_fc_rollup_effect` ON `file_change_rollups` (`last_effect_id`);--> statement-breakpoint
CREATE TABLE `file_change_scopes` (
	`id` text PRIMARY KEY NOT NULL,
	`source_instance_id` text NOT NULL,
	`device_id` text NOT NULL,
	`workspace_instance_id` text NOT NULL,
	`canonical_root` text NOT NULL,
	`display_root` text NOT NULL,
	`path_flavor` text NOT NULL,
	`status` text DEFAULT 'needs_verification' NOT NULL,
	`root_identity_json` text,
	`revision` integer DEFAULT 0 NOT NULL,
	`fencing_token` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_fc_scope_instance` ON `file_change_scopes` (`source_instance_id`,`device_id`,`workspace_instance_id`);--> statement-breakpoint
CREATE INDEX `idx_fc_scope_root` ON `file_change_scopes` (`source_instance_id`,`device_id`,`canonical_root`);--> statement-breakpoint
CREATE INDEX `idx_fc_scope_status` ON `file_change_scopes` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `revert_operation_files` (
	`id` text PRIMARY KEY NOT NULL,
	`revert_operation_id` text NOT NULL,
	`scope_id` text NOT NULL,
	`file_key` text NOT NULL,
	`identity_json` text NOT NULL,
	`sequence` integer NOT NULL,
	`expected_state_json` text NOT NULL,
	`desired_state_json` text NOT NULL,
	`observed_after_state_json` text,
	`before_blob_digest` text,
	`desired_blob_digest` text,
	`observed_after_blob_digest` text,
	`apply_mutation_id` text NOT NULL,
	`apply_request_digest` text NOT NULL,
	`compensate_mutation_id` text NOT NULL,
	`compensate_request_digest` text NOT NULL,
	`status` text DEFAULT 'prepared' NOT NULL,
	`receipt_json` text,
	`reason` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`revert_operation_id`) REFERENCES `revert_operations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scope_id`) REFERENCES `file_change_scopes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`before_blob_digest`) REFERENCES `file_change_blobs`(`digest`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`desired_blob_digest`) REFERENCES `file_change_blobs`(`digest`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`observed_after_blob_digest`) REFERENCES `file_change_blobs`(`digest`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_revert_file_identity` ON `revert_operation_files` (`revert_operation_id`,`file_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_revert_file_apply` ON `revert_operation_files` (`apply_mutation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_revert_file_compensate` ON `revert_operation_files` (`compensate_mutation_id`);--> statement-breakpoint
CREATE INDEX `idx_revert_file_pending` ON `revert_operation_files` (`revert_operation_id`,`status`,`sequence`);--> statement-breakpoint
CREATE INDEX `idx_revert_file_before_blob` ON `revert_operation_files` (`before_blob_digest`);--> statement-breakpoint
CREATE INDEX `idx_revert_file_desired_blob` ON `revert_operation_files` (`desired_blob_digest`);--> statement-breakpoint
CREATE INDEX `idx_revert_file_observed_blob` ON `revert_operation_files` (`observed_after_blob_digest`);--> statement-breakpoint
CREATE TABLE `revert_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`protocol_version` integer DEFAULT 2 NOT NULL,
	`narrator_id` text,
	`project_id` text,
	`requested_by_subject_key` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`kind` text NOT NULL,
	`scope` text NOT NULL,
	`selector_kind` text NOT NULL,
	`selector_blob_digest` text,
	`plan_blob_digest` text,
	`history_manifest_blob_digest` text,
	`plan_hash` text,
	`expected_message_version` integer,
	`parent_revert_id` text,
	`status` text DEFAULT 'planned' NOT NULL,
	`file_count` integer DEFAULT 0 NOT NULL,
	`applied_file_count` integer DEFAULT 0 NOT NULL,
	`coverage_complete` integer DEFAULT false NOT NULL,
	`reason` text,
	`expires_at` text NOT NULL,
	`lease_until` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`selector_blob_digest`) REFERENCES `file_change_blobs`(`digest`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plan_blob_digest`) REFERENCES `file_change_blobs`(`digest`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`history_manifest_blob_digest`) REFERENCES `file_change_blobs`(`digest`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_revert_operation_request` ON `revert_operations` (`requested_by_subject_key`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_revert_operation_narrator` ON `revert_operations` (`narrator_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_revert_operation_pending` ON `revert_operations` (`status`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_revert_operation_parent` ON `revert_operations` (`parent_revert_id`);--> statement-breakpoint
CREATE INDEX `idx_revert_operation_plan_blob` ON `revert_operations` (`plan_blob_digest`);--> statement-breakpoint
CREATE INDEX `idx_revert_operation_selector_blob` ON `revert_operations` (`selector_blob_digest`);--> statement-breakpoint
CREATE INDEX `idx_revert_operation_history_blob` ON `revert_operations` (`history_manifest_blob_digest`);--> statement-breakpoint
CREATE TABLE `snapshot_captures` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_id` text NOT NULL,
	`operation_id` text,
	`tree_hash` text,
	`snapshot_commit_sha` text,
	`coverage` text DEFAULT 'unavailable' NOT NULL,
	`temporal_consistency` text DEFAULT 'unknown' NOT NULL,
	`policy_version` integer NOT NULL,
	`ignore_policy_digest` text,
	`manifest_blob_digest` text,
	`omitted_count` integer,
	`reason` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`scope_id`) REFERENCES `file_change_scopes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`operation_id`) REFERENCES `file_change_operations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`manifest_blob_digest`) REFERENCES `file_change_blobs`(`digest`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_snapshot_capture_scope` ON `snapshot_captures` (`scope_id`,`started_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_snapshot_capture_tree` ON `snapshot_captures` (`scope_id`,`tree_hash`);--> statement-breakpoint
CREATE INDEX `idx_snapshot_capture_operation` ON `snapshot_captures` (`operation_id`);--> statement-breakpoint
CREATE INDEX `idx_snapshot_capture_manifest` ON `snapshot_captures` (`manifest_blob_digest`);