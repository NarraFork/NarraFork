PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE INDEX `idx_bg_tasks_active` ON `background_tasks` (`status`) WHERE "status" IN ('running','paused');
--> statement-breakpoint
PRAGMA foreign_keys=ON;
