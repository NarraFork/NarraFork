PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `project_teams` (
	`narrator_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`base_branch` text NOT NULL,
	`brief` text DEFAULT '' NOT NULL,
	`settings_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_project_teams_status" CHECK("project_teams"."status" in ('active', 'archived')),
	CONSTRAINT "ck_project_teams_brief_bytes" CHECK(length(cast("project_teams"."brief" as blob)) <= 4096),
	CONSTRAINT "ck_project_teams_settings_bytes" CHECK(length(cast("project_teams"."settings_json" as blob)) <= 16384)
);
--> statement-breakpoint
CREATE INDEX `idx_project_teams_project_status` ON `project_teams` (`project_id`,`status`,`narrator_id`);
--> statement-breakpoint
CREATE INDEX `idx_project_teams_created_by` ON `project_teams` (`created_by`);
--> statement-breakpoint
CREATE TABLE `team_work_events` (
	`id` text PRIMARY KEY NOT NULL,
	`work_item_id` text,
	`team_id` text NOT NULL,
	`kind` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`detail_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`work_item_id`) REFERENCES `team_work_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `project_teams`(`narrator_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ck_team_work_events_actor_kind" CHECK("team_work_events"."actor_kind" in ('person', 'agent', 'system')),
	CONSTRAINT "ck_team_work_events_detail_bytes" CHECK("team_work_events"."detail_json" is null or length(cast("team_work_events"."detail_json" as blob)) <= 8192)
);
--> statement-breakpoint
CREATE INDEX `idx_team_work_events_team_created` ON `team_work_events` (`team_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_team_work_events_item_created` ON `team_work_events` (`work_item_id`,`created_at`,`id`);
--> statement-breakpoint
CREATE TABLE `team_work_items` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`kind` text DEFAULT 'change' NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`branch_name` text,
	`base_ref` text,
	`worktree_resource_id` text,
	`head_sha` text,
	`worker_narrator_id` text,
	`review_rounds` integer DEFAULT 0 NOT NULL,
	`last_review` text,
	`changed_paths_json` text,
	`changed_paths_at_sha` text,
	`exclusive_key` text,
	`outline_space_id` text,
	`outline_block_id` text,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `project_teams`(`narrator_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`worktree_resource_id`) REFERENCES `narrator_worktree_resources`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`worker_narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_team_work_items_state" CHECK("team_work_items"."state" in ('queued', 'in_progress', 'in_review', 'ready', 'merged', 'cancelled')),
	CONSTRAINT "ck_team_work_items_last_review" CHECK("team_work_items"."last_review" is null or "team_work_items"."last_review" in ('blocker', 'clear')),
	CONSTRAINT "ck_team_work_items_review_rounds" CHECK("team_work_items"."review_rounds" >= 0),
	CONSTRAINT "ck_team_work_items_changed_paths_bytes" CHECK("team_work_items"."changed_paths_json" is null or length(cast("team_work_items"."changed_paths_json" as blob)) <= 131072)
);
--> statement-breakpoint
CREATE INDEX `idx_team_work_items_team_state` ON `team_work_items` (`team_id`,`state`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_team_work_items_project_state` ON `team_work_items` (`project_id`,`state`,`id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_team_work_items_exclusive` ON `team_work_items` (`project_id`,`exclusive_key`) WHERE "exclusive_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_team_work_items_worktree` ON `team_work_items` (`worktree_resource_id`);
--> statement-breakpoint
CREATE INDEX `idx_team_work_items_worker` ON `team_work_items` (`worker_narrator_id`);
--> statement-breakpoint
CREATE INDEX `idx_team_work_items_created_by` ON `team_work_items` (`created_by`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
