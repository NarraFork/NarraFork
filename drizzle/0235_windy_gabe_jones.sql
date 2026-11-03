PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE INDEX `idx_outline_blocks_finished_tasks` ON `outline_blocks` (`space_id`,`version_seq`,`id`) WHERE json_extract("task_json", '$.status') IN ('done', 'cancelled') AND "deleted" = 0;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
