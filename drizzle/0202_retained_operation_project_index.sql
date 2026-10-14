PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE INDEX `idx_fc_operation_project` ON `file_change_operations` (`project_id`,`id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
