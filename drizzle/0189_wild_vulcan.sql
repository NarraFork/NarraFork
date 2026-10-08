CREATE TABLE `narrator_worktree_resources` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_narrator_id` text,
	`device_id` text NOT NULL,
	`repository_key` text NOT NULL,
	`worktree_path` text NOT NULL,
	`state` text NOT NULL,
	`create_request_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`owner_narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_narrator_worktree_resource_path` ON `narrator_worktree_resources` (`device_id`,`worktree_path`);--> statement-breakpoint
CREATE INDEX `idx_narrator_worktree_resource_owner` ON `narrator_worktree_resources` (`owner_narrator_id`);--> statement-breakpoint
CREATE TABLE `permission_rule_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`narrator_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`tool_use_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`proposal_json` text NOT NULL,
	`proposal_hash` text NOT NULL,
	`reason` text NOT NULL,
	`scope` text DEFAULT 'narrator' NOT NULL,
	`device_id` text NOT NULL,
	`context_revision` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`rule_id` text,
	`approval_source` text,
	`approval_user_id` text,
	`reflection_conclusion` text,
	`error` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tool_call_id`) REFERENCES `narrator_tool_calls`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_permission_rule_request_attempt` ON `permission_rule_requests` (`tool_call_id`,`attempt`);--> statement-breakpoint
CREATE INDEX `idx_permission_rule_request_narrator_created` ON `permission_rule_requests` (`narrator_id`,`created_at`,`id`);--> statement-breakpoint
ALTER TABLE `narrators` ADD `workspace_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `narrators` ADD `workspace_context` text;