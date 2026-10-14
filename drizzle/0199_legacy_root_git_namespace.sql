PRAGMA foreign_keys=OFF;
--> statement-breakpoint
ALTER TABLE `legacy_narrator_workspace_adoptions` ADD `git_directory_dev` text;
--> statement-breakpoint
ALTER TABLE `legacy_narrator_workspace_adoptions` ADD `git_directory_ino` text;
--> statement-breakpoint
CREATE INDEX `idx_fc_scope_physical_root` ON `file_change_scopes` (`device_id`,`canonical_root`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
