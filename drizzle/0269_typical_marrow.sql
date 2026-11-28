PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE INDEX `idx_team_work_events_team_kind_created` ON `team_work_events` (`team_id`,`kind`,`created_at`,`id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
