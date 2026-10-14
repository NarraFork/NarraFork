PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE INDEX `idx_legacy_migration_archive_path` ON `legacy_project_migrations` (`archive_path`);
--> statement-breakpoint
CREATE INDEX `idx_projects_legacy_sync_disabled` ON `projects` (`legacy_sync_disabled`,`id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
