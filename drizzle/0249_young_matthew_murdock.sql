PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE INDEX `idx_workspace_panels_kind_workspace` ON `workspace_panels` (`kind`,`workspace_id`,`id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
