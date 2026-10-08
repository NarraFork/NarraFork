PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_background_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_narrator_id` text NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`command` text,
	`exit_code` integer,
	`subagent_narrator_id` text,
	`subagent_type` text,
	`tool_use_id` text,
	`alias` text,
	`title` text,
	`output` text,
	`output_bytes` integer DEFAULT 0 NOT NULL,
	`output_truncated` integer DEFAULT false NOT NULL,
	`notified` integer DEFAULT false NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`parent_narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subagent_narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_background_tasks`("id", "parent_narrator_id", "type", "status", "command", "exit_code", "subagent_narrator_id", "subagent_type", "tool_use_id", "alias", "title", "output", "output_bytes", "output_truncated", "notified", "started_at", "completed_at", "created_at", "updated_at") SELECT "id", "parent_narrator_id", "type", "status", "command", "exit_code", "subagent_narrator_id", "subagent_type", "tool_use_id", "alias", "title", "output", "output_bytes", "output_truncated", "notified", "started_at", "completed_at", "created_at", "updated_at" FROM `background_tasks`;--> statement-breakpoint
DROP TABLE `background_tasks`;--> statement-breakpoint
ALTER TABLE `__new_background_tasks` RENAME TO `background_tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_bg_tasks_parent` ON `background_tasks` (`parent_narrator_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_bg_tasks_subagent` ON `background_tasks` (`subagent_narrator_id`);