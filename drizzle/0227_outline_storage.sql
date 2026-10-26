PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `outline_block_versions` (
	`block_id` text NOT NULL,
	`from_seq` integer NOT NULL,
	`to_seq` integer,
	`commit_id` text NOT NULL,
	`page_id` text NOT NULL,
	`parent_id` text,
	`order_key` text NOT NULL,
	`content` text,
	`task_json` text,
	`alias` text,
	`content_hash` text NOT NULL,
	`change_flags` integer NOT NULL,
	`deleted` integer NOT NULL,
	PRIMARY KEY(`block_id`, `from_seq`),
	FOREIGN KEY (`block_id`) REFERENCES `outline_blocks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`commit_id`) REFERENCES `outline_commits`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_outline_versions_page_range` ON `outline_block_versions` (`page_id`,`from_seq`,`to_seq`);
--> statement-breakpoint
CREATE INDEX `idx_outline_versions_commit` ON `outline_block_versions` (`commit_id`);
--> statement-breakpoint
CREATE TABLE `outline_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`sid` text NOT NULL,
	`parent_id` text,
	`page_id` text NOT NULL,
	`order_key` text NOT NULL,
	`content` text NOT NULL,
	`content_hash` text NOT NULL,
	`alias` text,
	`task_json` text,
	`author_kind` text NOT NULL,
	`author_id` text NOT NULL,
	`version_seq` integer NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `outline_spaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_outline_blocks_space_sid` ON `outline_blocks` (`space_id`,`sid`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_outline_blocks_space_alias` ON `outline_blocks` (`space_id`,`alias`) WHERE "alias" IS NOT NULL AND "deleted" = 0;
--> statement-breakpoint
CREATE INDEX `idx_outline_blocks_page` ON `outline_blocks` (`page_id`);
--> statement-breakpoint
CREATE INDEX `idx_outline_blocks_children` ON `outline_blocks` (`space_id`,`parent_id`,`order_key`);
--> statement-breakpoint
CREATE TABLE `outline_commits` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`responsible_user_id` text,
	`narrator_id` text,
	`message_id` text,
	`tool_call_id` text,
	`created_at` text NOT NULL,
	`summary` text NOT NULL,
	FOREIGN KEY (`space_id`) REFERENCES `outline_spaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_outline_commits_space_seq` ON `outline_commits` (`space_id`,`seq`);
--> statement-breakpoint
CREATE INDEX `idx_outline_commits_space_narrator` ON `outline_commits` (`space_id`,`narrator_id`,`seq`);
--> statement-breakpoint
CREATE TABLE `outline_links` (
	`id` text PRIMARY KEY NOT NULL,
	`space_id` text NOT NULL,
	`from_block_id` text NOT NULL,
	`kind` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_ref` text NOT NULL,
	`from_seq` integer NOT NULL,
	`to_seq` integer,
	FOREIGN KEY (`from_block_id`) REFERENCES `outline_blocks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_outline_links_from` ON `outline_links` (`from_block_id`,`to_seq`);
--> statement-breakpoint
CREATE INDEX `idx_outline_links_target` ON `outline_links` (`target_kind`,`target_ref`);
--> statement-breakpoint
CREATE TABLE `outline_live_updates` (
	`page_block_id` text NOT NULL,
	`epoch` integer NOT NULL,
	`seq` integer NOT NULL,
	`update_b64` text NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`page_block_id`, `epoch`, `seq`),
	FOREIGN KEY (`page_block_id`) REFERENCES `outline_blocks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `outline_spaces` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`kind` text NOT NULL,
	`project_id` text,
	`narrator_id` text,
	`owner_user_id` text,
	`next_seq` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_outline_spaces_key` ON `outline_spaces` (`key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_outline_spaces_project` ON `outline_spaces` (`project_id`) WHERE "kind" = 'project';
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_outline_spaces_personal` ON `outline_spaces` (`owner_user_id`) WHERE "kind" = 'personal';
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_outline_spaces_session` ON `outline_spaces` (`narrator_id`) WHERE "kind" = 'session';
--> statement-breakpoint
CREATE INDEX `idx_outline_spaces_project` ON `outline_spaces` (`project_id`);
--> statement-breakpoint
CREATE INDEX `idx_outline_spaces_narrator` ON `outline_spaces` (`narrator_id`);
--> statement-breakpoint
CREATE INDEX `idx_outline_spaces_owner` ON `outline_spaces` (`owner_user_id`);
--> statement-breakpoint
CREATE TABLE `outline_view_state` (
	`user_id` text NOT NULL,
	`page_block_id` text NOT NULL,
	`collapsed_json` text DEFAULT '[]' NOT NULL,
	`layout` text DEFAULT 'right' NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `page_block_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`page_block_id`) REFERENCES `outline_blocks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_outline_view_state_page` ON `outline_view_state` (`page_block_id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
