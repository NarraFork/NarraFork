PRAGMA foreign_keys=OFF;
--> statement-breakpoint
ALTER TABLE `legacy_project_migrations` ADD `archive_identity_json` text;
--> statement-breakpoint
CREATE INDEX `idx_projects_legacy_sync_path` ON `projects` (`git_path`,`legacy_sync_disabled`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
