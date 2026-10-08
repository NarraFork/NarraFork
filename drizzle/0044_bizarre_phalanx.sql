CREATE TABLE `file_attributions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_path` text NOT NULL,
	`file_path` text NOT NULL,
	`narrator_id` text,
	`subagent_type` text,
	`action` text NOT NULL,
	`tool_name` text,
	`tool_use_id` text,
	`changed_at` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_file_attr_workspace_file` ON `file_attributions` (`workspace_path`,`file_path`,`changed_at`);--> statement-breakpoint
CREATE INDEX `idx_file_attr_narrator` ON `file_attributions` (`narrator_id`);--> statement-breakpoint
CREATE INDEX `idx_file_attr_workspace` ON `file_attributions` (`workspace_path`,`changed_at`);