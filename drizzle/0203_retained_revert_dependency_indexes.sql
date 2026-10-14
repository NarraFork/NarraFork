PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE INDEX `idx_revert_file_scope` ON `revert_operation_files` (`scope_id`,`id`);
--> statement-breakpoint
CREATE INDEX `idx_revert_operation_project` ON `revert_operations` (`project_id`,`id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
