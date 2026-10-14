PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `legacy_migration_artifact_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`migration_project_id` text NOT NULL,
	`source_chapter_id` text NOT NULL,
	`narrator_id` text,
	`owner_user_id` text,
	`kind` text NOT NULL,
	`device_id` text NOT NULL,
	`workspace_path` text NOT NULL,
	`artifact_path` text NOT NULL,
	`shadow_key` text,
	`latest_snapshot_commit_sha` text,
	`identity_json` text NOT NULL,
	`manifest_digest` text NOT NULL,
	`state` text DEFAULT 'claimed' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`migration_project_id`) REFERENCES `legacy_project_migrations`(`project_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`source_chapter_id`) REFERENCES `legacy_retained_chapter_metadata`(`source_chapter_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_legacy_artifact_workspace` ON `legacy_migration_artifact_claims` (`device_id`,`workspace_path`,`state`);
--> statement-breakpoint
CREATE INDEX `idx_legacy_artifact_shadow_key` ON `legacy_migration_artifact_claims` (`shadow_key`,`state`);
--> statement-breakpoint
CREATE INDEX `idx_legacy_artifact_path` ON `legacy_migration_artifact_claims` (`artifact_path`,`state`);
--> statement-breakpoint
CREATE INDEX `idx_legacy_artifact_chapter` ON `legacy_migration_artifact_claims` (`source_chapter_id`,`state`);
--> statement-breakpoint
CREATE INDEX `idx_legacy_artifact_narrator` ON `legacy_migration_artifact_claims` (`narrator_id`);
--> statement-breakpoint
CREATE INDEX `idx_legacy_artifact_migration` ON `legacy_migration_artifact_claims` (`migration_project_id`);
--> statement-breakpoint
CREATE TABLE `legacy_retained_chapter_metadata` (
	`source_chapter_id` text PRIMARY KEY NOT NULL,
	`migration_project_id` text NOT NULL,
	`metadata_json` text NOT NULL,
	`manifest_digest` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`migration_project_id`) REFERENCES `legacy_project_migrations`(`project_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
