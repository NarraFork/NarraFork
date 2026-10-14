PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `narrator_worktree_resource_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`resource_id` text NOT NULL,
	`migration_project_id` text NOT NULL,
	`source_chapter_id` text NOT NULL,
	`narrator_id` text,
	`owner_user_id` text,
	`state` text DEFAULT 'unresolved' NOT NULL,
	`ownership_revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`resource_id`) REFERENCES `narrator_worktree_resources`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`migration_project_id`) REFERENCES `legacy_project_migrations`(`project_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ck_worktree_resource_claim_revision" CHECK("narrator_worktree_resource_claims"."ownership_revision" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_worktree_resource_claim_user` ON `narrator_worktree_resource_claims` (`resource_id`,`narrator_id`);
--> statement-breakpoint
CREATE INDEX `idx_worktree_resource_claim_migration` ON `narrator_worktree_resource_claims` (`migration_project_id`);
--> statement-breakpoint
CREATE INDEX `idx_worktree_resource_claim_chapter` ON `narrator_worktree_resource_claims` (`source_chapter_id`);
--> statement-breakpoint
CREATE INDEX `idx_worktree_resource_claim_narrator` ON `narrator_worktree_resource_claims` (`narrator_id`);
--> statement-breakpoint
CREATE INDEX `idx_worktree_resource_claim_owner` ON `narrator_worktree_resource_claims` (`owner_user_id`);
--> statement-breakpoint
CREATE TABLE `narrator_worktree_resource_origins` (
	`resource_id` text PRIMARY KEY NOT NULL,
	`migration_project_id` text NOT NULL,
	`source_chapter_id` text NOT NULL,
	`device_id` text NOT NULL,
	`common_directory_path` text NOT NULL,
	`git_admin_directory_path` text NOT NULL,
	`evidence_json` text NOT NULL,
	`evidence_digest` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`resource_id`) REFERENCES `narrator_worktree_resources`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`migration_project_id`) REFERENCES `legacy_project_migrations`(`project_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "ck_worktree_origin_evidence_bytes" CHECK(length(cast("narrator_worktree_resource_origins"."evidence_json" as blob)) <= 16384)
);
--> statement-breakpoint
CREATE INDEX `idx_worktree_origin_migration` ON `narrator_worktree_resource_origins` (`migration_project_id`);
--> statement-breakpoint
CREATE INDEX `idx_worktree_origin_chapter` ON `narrator_worktree_resource_origins` (`source_chapter_id`);
--> statement-breakpoint
CREATE INDEX `idx_worktree_origin_common` ON `narrator_worktree_resource_origins` (`device_id`,`common_directory_path`);
--> statement-breakpoint
CREATE INDEX `idx_worktree_origin_admin` ON `narrator_worktree_resource_origins` (`device_id`,`git_admin_directory_path`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
