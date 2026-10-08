CREATE TABLE `overseers` (
	`id` text PRIMARY KEY NOT NULL,
	`narrator_id` text NOT NULL,
	`scope` text NOT NULL,
	`project_id` text,
	`enabled` integer DEFAULT true NOT NULL,
	`policy_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `overseers_narrator_id_unique` ON `overseers` (`narrator_id`);--> statement-breakpoint
CREATE INDEX `idx_overseers_narrator` ON `overseers` (`narrator_id`);--> statement-breakpoint
CREATE INDEX `idx_overseers_project` ON `overseers` (`project_id`);--> statement-breakpoint
CREATE INDEX `idx_overseers_scope` ON `overseers` (`scope`);--> statement-breakpoint
ALTER TABLE `narrator_tool_calls` ADD `permission_overseer_narrator_id` text REFERENCES narrators(id);