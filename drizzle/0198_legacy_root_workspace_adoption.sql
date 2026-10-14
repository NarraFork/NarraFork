PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `legacy_narrator_workspace_adoptions` (
	`narrator_id` text PRIMARY KEY NOT NULL,
	`migration_project_id` text NOT NULL,
	`previous_revision` integer NOT NULL,
	`adopted_revision` integer NOT NULL,
	`device_id` text NOT NULL,
	`cwd` text NOT NULL,
	`context_key` text NOT NULL,
	`history_digest` text NOT NULL,
	`workspace_key` text,
	`repository_key` text,
	`directory_dev` text NOT NULL,
	`directory_ino` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`narrator_id`) REFERENCES `narrators`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`migration_project_id`) REFERENCES `legacy_project_migrations`(`project_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_legacy_workspace_adoption_migration` ON `legacy_narrator_workspace_adoptions` (`migration_project_id`);
--> statement-breakpoint
CREATE TABLE `legacy_project_sync_tombstones` (
	`canonical_root` text PRIMARY KEY NOT NULL,
	`disabled_project_id` text NOT NULL,
	`disabled_at` text NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
