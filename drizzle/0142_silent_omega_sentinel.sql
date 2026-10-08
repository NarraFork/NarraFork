CREATE TABLE `workspace_panels` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`kind` text NOT NULL,
	`narrator_id` text,
	`config_json` text,
	`sort_order` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_workspace_panels_workspace` ON `workspace_panels` (`workspace_id`,`sort_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_workspace_panels_narrator` ON `workspace_panels` (`workspace_id`,`narrator_id`);--> statement-breakpoint
CREATE INDEX `idx_workspace_panels_narrator_lookup` ON `workspace_panels` (`narrator_id`);--> statement-breakpoint
ALTER TABLE `workspaces` ADD `layout_revision` integer DEFAULT 0 NOT NULL;