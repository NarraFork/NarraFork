PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_file_attributions` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text DEFAULT 'local' NOT NULL,
	`workspace_path` text NOT NULL,
	`file_path` text NOT NULL,
	`narrator_id` text,
	`user_id` text,
	`subagent_type` text,
	`action` text NOT NULL,
	`tool_name` text,
	`tool_use_id` text,
	`operation_id` text,
	`effect_id` text,
	`scope_id` text,
	`file_key` text,
	`actor_subject_key` text,
	`actor_snapshot_json` text,
	`attribution_grade` text,
	`lines_added` integer,
	`lines_removed` integer,
	`changed_at` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`operation_id`) REFERENCES `file_change_operations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`effect_id`) REFERENCES `file_change_effects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`scope_id`) REFERENCES `file_change_scopes`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_file_attr_line_counts" CHECK(
			("__new_file_attributions"."lines_added" IS NULL OR (typeof("__new_file_attributions"."lines_added") = 'integer' AND "__new_file_attributions"."lines_added" >= 0))
			AND ("__new_file_attributions"."lines_removed" IS NULL OR (typeof("__new_file_attributions"."lines_removed") = 'integer' AND "__new_file_attributions"."lines_removed" >= 0))
		)
);
--> statement-breakpoint
INSERT INTO `__new_file_attributions`("id", "device_id", "workspace_path", "file_path", "narrator_id", "user_id", "subagent_type", "action", "tool_name", "tool_use_id", "operation_id", "effect_id", "scope_id", "file_key", "actor_subject_key", "actor_snapshot_json", "attribution_grade", "lines_added", "lines_removed", "changed_at") SELECT "id", "device_id", "workspace_path", "file_path", "narrator_id", "user_id", "subagent_type", "action", "tool_name", "tool_use_id", "operation_id", "effect_id", "scope_id", "file_key", "actor_subject_key", "actor_snapshot_json", "attribution_grade", "lines_added", "lines_removed", "changed_at" FROM `file_attributions`;--> statement-breakpoint
DROP TABLE `file_attributions`;--> statement-breakpoint
ALTER TABLE `__new_file_attributions` RENAME TO `file_attributions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_file_attr_workspace_file` ON `file_attributions` (`workspace_path`,`file_path`,`changed_at`);--> statement-breakpoint
CREATE INDEX `idx_file_attr_device_workspace_file` ON `file_attributions` (`device_id`,`workspace_path`,`file_path`,`changed_at`);--> statement-breakpoint
CREATE INDEX `idx_file_attr_narrator` ON `file_attributions` (`narrator_id`);--> statement-breakpoint
CREATE INDEX `idx_file_attr_workspace` ON `file_attributions` (`workspace_path`,`changed_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_file_attr_effect` ON `file_attributions` (`effect_id`);--> statement-breakpoint
CREATE INDEX `idx_file_attr_operation` ON `file_attributions` (`operation_id`);--> statement-breakpoint
CREATE INDEX `idx_file_attr_scope_file` ON `file_attributions` (`scope_id`,`file_key`,`changed_at`,`id`);