PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE INDEX `idx_outline_blocks_active_tasks` ON `outline_blocks` (`space_id`) WHERE "deleted" = 0 AND (json_extract("task_json", '$.status') = 'doing' OR (json_extract("task_json", '$.status') = 'todo' AND json_extract("task_json", '$.lock') IS NOT NULL));
--> statement-breakpoint
PRAGMA foreign_keys=ON;
